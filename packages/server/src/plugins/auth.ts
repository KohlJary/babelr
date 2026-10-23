// SPDX-License-Identifier: Hippocratic-3.0
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { sessions } from '../db/schema/sessions.ts';
import { agentTokens } from '../db/schema/agent-tokens.ts';
import { objects } from '../db/schema/objects.ts';
import { auditLogs } from '../db/schema/audit-logs.ts';
import { checkScopes, type AgentScope } from '../agent-scopes.ts';
import { hashSecret, hashesMatch, parseToken } from '../agent-tokens.ts';
import { isSponsoredKind } from '../actor-kind.ts';

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'babelr_sid';
/** Don't rewrite last_used_at more than once a minute per token. */
const LAST_USED_DEBOUNCE_MS = 60 * 1000;

/** Channel routes whose target turns out to be a DM need the DM scope
 *  instead, so `channels:*` can't be used to reach DMs. */
const DM_SCOPE_FOR: Partial<Record<AgentScope, AgentScope>> = {
  'channels:read': 'dms:read',
  'channels:post': 'dms:post',
};

async function authPlugin(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;

  // Session middleware: attach actor to request if valid session cookie exists
  fastify.decorateRequest('actor', undefined);
  fastify.decorateRequest('agentAuth', undefined);

  fastify.addHook('onRequest', async (request, reply) => {
    const authz = request.headers.authorization;
    if (typeof authz === 'string' && /^bearer\s/i.test(authz)) {
      // A bearer token is always the agent path, even if a cookie is
      // also present: the request is the agent's, never a session's.
      return authenticateToken(request, reply, authz.replace(/^bearer\s+/i, ''));
    }

    const sid = request.cookies[COOKIE_NAME];
    if (!sid) return;

    const [session] = await db.select().from(sessions).where(eq(sessions.sid, sid)).limit(1);

    if (!session || session.expiresAt < new Date()) {
      if (session) {
        await db.delete(sessions).where(eq(sessions.sid, sid));
      }
      return;
    }

    const [actor] = await db.select().from(actors).where(eq(actors.id, session.actorId)).limit(1);

    // Agents and services authenticate only with tokens. A session
    // for one (there is no way to create one, but belt and braces)
    // authenticates nobody.
    if (actor && !isSponsoredKind(actor.kind)) {
      request.actor = actor;
    }
  });

  async function authenticateToken(request: FastifyRequest, reply: FastifyReply, raw: string) {
    const deny = (status: 401 | 403, error: string) => reply.status(status).send({ error });

    const route = `${request.method === 'HEAD' ? 'GET' : request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
    // Every token request is audited, bad ones included. A token that
    // matches no agent is logged by a short hash prefix, never itself.
    request.agentAuth = {
      tokenId: null,
      actorId: null,
      sponsorId: null,
      scope: null,
      route,
      action: 'denied',
      fingerprint: hashSecret(raw).slice(0, 12),
    };

    const parsed = parseToken(raw);
    if (!parsed) {
      request.agentAuth.denial = 'malformed_token';
      return deny(401, 'Invalid token');
    }

    const [token] = await db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.id, parsed.id))
      .limit(1);
    if (!token) {
      request.agentAuth.denial = 'unknown_token';
      return deny(401, 'Invalid token');
    }

    const [agent] = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
    request.agentAuth.tokenId = token.id;
    request.agentAuth.actorId = agent?.id ?? null;
    request.agentAuth.sponsorId = agent?.sponsorId ?? null;
    if (!hashesMatch(hashSecret(parsed.secret), token.tokenHash)) {
      // Someone holds this token's id but not its secret: the agent's
      // sponsor will want to see that.
      request.agentAuth.denial = 'bad_secret';
      return deny(401, 'Invalid token');
    }
    if (!agent) {
      request.agentAuth.denial = 'unknown_token';
      return deny(401, 'Invalid token');
    }

    // Revoked, expired, suspended, unsponsored, or a sponsor who is
    // gone or suspended: 401 on this request, logged as a denial.
    const now = new Date();
    let refusal: string | null = null;
    if (token.revokedAt) refusal = 'token_revoked';
    else if (token.expiresAt && token.expiresAt <= now) refusal = 'token_expired';
    else if (agent.suspendedAt) refusal = 'agent_suspended';
    else if (!isSponsoredKind(agent.kind) || !agent.sponsorId || !agent.local) {
      refusal = 'not_an_agent';
    } else {
      const [sponsor] = await db
        .select({ id: actors.id, kind: actors.kind, suspendedAt: actors.suspendedAt })
        .from(actors)
        .where(eq(actors.id, agent.sponsorId))
        .limit(1);
      if (!sponsor || sponsor.kind !== 'person' || sponsor.suspendedAt) refusal = 'no_sponsor';
    }
    if (refusal) {
      request.agentAuth.denial = refusal;
      return deny(401, 'Token not valid');
    }

    const scopes = Array.isArray(token.scopes) ? (token.scopes as string[]) : [];
    const params = (request.params ?? {}) as Record<string, unknown>;
    let decision = checkScopes(request.method, request.routeOptions.url, params, scopes);

    // A channel route aimed at a DM needs the DM scope.
    if (decision.allowed && decision.rule.param === 'channelId' && decision.rule.scope) {
      const dmScope = DM_SCOPE_FOR[decision.rule.scope];
      const channelId = params.channelId;
      if (dmScope && typeof channelId === 'string' && /^[0-9a-f-]{36}$/i.test(channelId)) {
        const [ch] = await db
          .select({ belongsTo: objects.belongsTo })
          .from(objects)
          .where(eq(objects.id, channelId))
          .limit(1);
        if (ch && !ch.belongsTo) {
          const granted = scopes.includes(dmScope)
            ? dmScope
            : scopes.includes(`${dmScope}:${channelId}`)
              ? `${dmScope}:${channelId}`
              : null;
          decision = granted
            ? { allowed: true, rule: decision.rule, grantedBy: granted }
            : { allowed: false, rule: decision.rule, reason: 'missing_scope' };
        }
      }
    }

    request.agentAuth.action = decision.rule?.action ?? 'unmapped';
    if (!decision.allowed) {
      request.agentAuth.scope = decision.rule?.scope ?? null;
      request.agentAuth.denial = decision.reason;
      return deny(403, 'Token scope does not allow this');
    }

    request.agentAuth.scope = decision.grantedBy;
    request.actor = agent;
    request.agentScopes = scopes;

    if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
      await db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, token.id));
    }
  }

  // Audit every token request, allowed or denied, once the response
  // status is known. onSend, not onResponse: the row is written before
  // the response goes out, so whoever gets the response (a sponsor, a
  // test) can already read it, and nothing writes after the request is
  // over. A failure is logged, never thrown.
  fastify.addHook('onSend', async (request, reply, payload) => {
    const a = request.agentAuth;
    if (!a) return payload;
    const denied = !!a.denial || reply.statusCode === 401 || reply.statusCode === 403;
    try {
      await db.insert(auditLogs).values({
        serverId: null,
        actorId: a.actorId,
        sponsorId: a.sponsorId,
        category: 'agent',
        action: `agent.${denied ? 'denied' : a.action}`.slice(0, 64),
        summary: `${a.route} -> ${reply.statusCode}${a.denial ? ` (${a.denial})` : ''}`,
        scope: a.scope,
        route: a.route,
        details: {
          tokenId: a.tokenId,
          ...(a.actorId ? {} : { tokenFingerprint: a.fingerprint }),
          status: reply.statusCode,
          ...(a.denial ? { denial: a.denial } : {}),
          ...(denied ? { attempted: a.action } : {}),
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to write agent audit log');
    }
    return payload;
  });

  // Helper: create session and set cookie
  fastify.decorate('createSession', async (actorId: string, reply: FastifyReply) => {
    const [who] = await db
      .select({ kind: actors.kind })
      .from(actors)
      .where(eq(actors.id, actorId))
      .limit(1);
    if (who && isSponsoredKind(who.kind)) {
      throw new Error('Agents and services cannot have browser sessions');
    }
    const sid = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE);

    await db.insert(sessions).values({
      sid,
      actorId,
      expiresAt,
    });

    reply.setCookie(COOKIE_NAME, sid, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'strict',
      maxAge: SESSION_MAX_AGE / 1000,
      path: '/',
    });

    return sid;
  });

  // Helper: destroy session
  fastify.decorate('destroySession', async (request: FastifyRequest, reply: FastifyReply) => {
    const sid = request.cookies[COOKIE_NAME];
    if (sid) {
      await db.delete(sessions).where(eq(sessions.sid, sid));
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['db', 'config-plugin', '@fastify/cookie'],
});
