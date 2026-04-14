// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { PERMISSIONS } from '@babelr/shared';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { hasPermission } from '../permissions.ts';
import { verifySignedRequest } from '../federation/inbox.ts';
import { extractDomain, isDomainAllowed } from '../federation/policy.ts';
import { signedPost } from '../federation/delivery.ts';
import {
  issueVoiceFederationToken,
  type VoiceFederationClaims,
} from '../voice/federation-jwt.ts';

interface FederationTokenRequest {
  /**
   * Full channel URI on the origin Tower. We look up by URI rather than
   * trusting the caller to supply the row id — local row ids and URI
   * UUIDs are independently generated and do not match.
   */
  channelUri: string;
}

interface FederationTokenResponse {
  token: string;
  /** Origin Tower's WS URL (wss://...) — the browser will dial this. */
  wsUrl: string;
  /**
   * Channel id as known on the *origin* Tower. The browser uses this
   * value in voice:join, since the home Tower's cached id is different.
   */
  channelId: string;
  /** TTL in seconds, for client-side refresh logic. */
  expiresIn: number;
}

interface ProxyTokenRequest {
  /** Full channel URI, e.g. https://tower-a.example.com/objects/<uuid>. */
  channelUri: string;
}

export default async function voiceRoutes(fastify: FastifyInstance) {
  /**
   * Origin-Tower endpoint. A remote home Tower POSTs an HTTP-signed
   * request asking us to issue a JWT authorizing one of their actors to
   * join one of our voice channels. We:
   *   1. Verify the signature -> get the calling actor (the remote user)
   *   2. Check our federation policy lets that domain in
   *   3. Check the channel exists, is voice, and is owned by us
   *   4. Check the remote actor has CONNECT_VOICE on the owning Group
   *   5. Issue the JWT
   */
  fastify.post<{ Body: FederationTokenRequest }>(
    '/voice/federation-token',
    async (request, reply) => {
      const remoteActor = await verifySignedRequest(fastify, {
        headers: request.headers as Record<string, string | string[] | undefined>,
        method: 'POST',
        url: request.url,
      });
      if (!remoteActor) {
        return reply.status(401).send({ error: 'Invalid or missing signature' });
      }
      if (remoteActor.local) {
        return reply.status(400).send({ error: 'Local actor used remote token endpoint' });
      }
      const remoteDomain = extractDomain(remoteActor.uri);
      if (!remoteDomain || !isDomainAllowed(fastify.config, remoteDomain)) {
        return reply.status(403).send({ error: 'Federation policy denies this domain' });
      }

      const { channelUri } = request.body ?? ({} as FederationTokenRequest);
      if (!channelUri || typeof channelUri !== 'string') {
        return reply.status(400).send({ error: 'channelUri is required' });
      }

      const [channel] = await fastify.db
        .select({
          id: objects.id,
          type: objects.type,
          properties: objects.properties,
          belongsTo: objects.belongsTo,
        })
        .from(objects)
        .where(eq(objects.uri, channelUri))
        .limit(1);
      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }
      const channelType =
        (channel.properties as Record<string, unknown> | null)?.channelType;
      if (channelType !== 'voice') {
        return reply.status(400).send({ error: 'Channel is not a voice channel' });
      }
      if (!channel.belongsTo) {
        return reply.status(400).send({ error: 'Channel has no owning server' });
      }
      // Channel must be locally-owned for this Tower to issue a token.
      const [owner] = await fastify.db
        .select({ local: actors.local })
        .from(actors)
        .where(eq(actors.id, channel.belongsTo))
        .limit(1);
      if (!owner?.local) {
        return reply.status(400).send({ error: 'Channel is not owned by this Tower' });
      }

      const allowed = await hasPermission(
        fastify.db,
        channel.belongsTo,
        remoteActor.id,
        PERMISSIONS.CONNECT_VOICE,
      );
      if (!allowed) {
        return reply.status(403).send({ error: 'Remote actor lacks CONNECT_VOICE' });
      }

      const token = issueVoiceFederationToken({
        secret: fastify.config.sessionSecret,
        actorUri: remoteActor.uri,
        channelId: channel.id,
        issuerDomain: fastify.config.domain,
      });
      const protocol = fastify.config.secureCookies ? 'wss' : 'ws';
      const response: FederationTokenResponse = {
        token,
        wsUrl: `${protocol}://${fastify.config.domain}/ws`,
        channelId: channel.id,
        expiresIn: 5 * 60,
      };
      return reply.send(response);
    },
  );

  /**
   * Home-Tower endpoint. A signed-in local user wants to join a voice
   * channel that lives on a remote Tower. We resolve the channel URI
   * to the remote domain, then make an HTTP-signed POST to that Tower's
   * /api/voice/federation-token on the user's behalf and return the
   * resulting JWT to the browser. The browser then opens its WS to the
   * remote Tower directly with the JWT.
   */
  fastify.post<{ Body: ProxyTokenRequest }>(
    '/voice/request-federation-token',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }
      const { channelUri } = request.body ?? ({} as ProxyTokenRequest);
      if (!channelUri || typeof channelUri !== 'string') {
        return reply.status(400).send({ error: 'channelUri is required' });
      }

      let channelUrl: URL;
      try {
        channelUrl = new URL(channelUri);
      } catch {
        return reply.status(400).send({ error: 'Invalid channelUri' });
      }
      // host includes the port, which matters in dev where Towers run
      // on non-default ports (babelr-a.local:3000 etc).
      if (channelUrl.host === fastify.config.domain) {
        return reply.status(400).send({ error: 'Channel is local to this Tower' });
      }
      // Federation policy operates on hostname (port-less). isDomainAllowed
      // takes a hostname, so pass channelUrl.hostname.
      if (!isDomainAllowed(fastify.config, channelUrl.hostname)) {
        return reply.status(403).send({ error: 'Federation policy denies this domain' });
      }

      // Server-to-server fetches the unprefixed route directly (no Vite
      // in the federation path). Use the channel URI's own scheme + host
      // so the dev rig (http + nonstandard ports) and prod (https + 443)
      // both work without further config. Origin Tower resolves the URI
      // to its own row id; we don't try to parse the UUID out client-side
      // because URI segments and row ids are independently generated.
      const tokenUrl = `${channelUrl.protocol}//${channelUrl.host}/voice/federation-token`;
      const result = await signedPost<FederationTokenResponse>(
        fastify.db,
        request.actor.id,
        tokenUrl,
        { channelUri },
      );
      if (result.status === 0 || !result.data) {
        return reply
          .status(502)
          .send({ error: 'Failed to reach remote Tower for token issuance' });
      }
      if (result.status !== 200) {
        return reply.status(result.status).send(result.data ?? { error: 'Token denied' });
      }
      return reply.send(result.data);
    },
  );
}

export type { FederationTokenResponse, VoiceFederationClaims };
