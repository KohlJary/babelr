// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';

/**
 * OIDC SSO routes. Enabled when all four OIDC_ env vars are set.
 *
 * Flow:
 * 1. GET /auth/oidc/authorize — redirects to IdP login page
 * 2. GET /auth/oidc/callback  — IdP redirects back with auth code
 *    → exchanges code for tokens → extracts claims → upserts actor
 *    → creates session → redirects to client
 */
export default async function ssoRoutes(fastify: FastifyInstance) {
  const config = fastify.config;

  if (!config.oidcIssuer || !config.oidcClientId || !config.oidcClientSecret || !config.oidcRedirectUri) {
    fastify.log.info('OIDC SSO not configured — skipping SSO routes');
    return;
  }

  // Discover the OIDC provider configuration
  let oidcConfig: oidc.Configuration;
  try {
    oidcConfig = await oidc.discovery(
      new URL(config.oidcIssuer),
      config.oidcClientId,
      config.oidcClientSecret,
    );
  } catch (err) {
    fastify.log.error({ err }, 'Failed to discover OIDC provider — SSO disabled');
    return;
  }

  // In-memory nonce/state store for pending auth flows.
  // Key: state parameter, Value: { nonce, codeVerifier, createdAt }
  const pendingFlows = new Map<
    string,
    { nonce: string; codeVerifier: string; createdAt: number }
  >();

  // Clean up stale flows older than 10 minutes
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, val] of pendingFlows) {
      if (val.createdAt < cutoff) pendingFlows.delete(key);
    }
  }, 60_000);

  // Expose SSO availability to the client (no auth required)
  fastify.get('/auth/sso-config', async () => {
    return { oidcEnabled: true };
  });

  // Step 1: Redirect to IdP
  fastify.get('/auth/oidc/authorize', async (_request, reply) => {
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    pendingFlows.set(state, { nonce, codeVerifier, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: config.oidcClientId!,
      redirect_uri: config.oidcRedirectUri!,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authEndpoint = oidcConfig.serverMetadata().authorization_endpoint;
    if (!authEndpoint) {
      return reply.status(500).send({ error: 'OIDC provider missing authorization_endpoint' });
    }

    return reply.redirect(`${authEndpoint}?${params.toString()}`);
  });

  // Step 2: Handle callback from IdP
  fastify.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/auth/oidc/callback', async (request, reply) => {
    const { code, state, error, error_description } = request.query;

    if (error) {
      fastify.log.warn({ error, error_description }, 'OIDC callback error');
      return reply.redirect('/?sso_error=' + encodeURIComponent(error_description ?? error));
    }

    if (!code || !state) {
      return reply.redirect('/?sso_error=missing_params');
    }

    const pending = pendingFlows.get(state);
    if (!pending) {
      return reply.redirect('/?sso_error=invalid_state');
    }
    pendingFlows.delete(state);

    // Exchange code for tokens
    let tokenResult: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokenResult = await oidc.authorizationCodeGrant(oidcConfig, new URL(request.url, `http://${request.hostname}`), {
        pkceCodeVerifier: pending.codeVerifier,
        expectedNonce: pending.nonce,
        expectedState: state,
      });
    } catch (err) {
      fastify.log.error({ err }, 'OIDC token exchange failed');
      return reply.redirect('/?sso_error=token_exchange_failed');
    }

    // Extract claims from ID token
    const claims = tokenResult.claims();
    if (!claims) {
      return reply.redirect('/?sso_error=no_claims');
    }

    const sub = claims.sub as string;
    const email = (claims as Record<string, unknown>).email as string | undefined;
    const name = ((claims as Record<string, unknown>).name as string | undefined)
      ?? ((claims as Record<string, unknown>).preferred_username as string | undefined);

    if (!sub) {
      return reply.redirect('/?sso_error=no_subject');
    }

    const db = fastify.db;
    const protocol = config.secureCookies ? 'https' : 'http';

    // Look up existing actor by OIDC subject or email
    let actor: typeof actors.$inferSelect | undefined;

    // First try by OIDC subject stored in properties
    const allLocal = await db
      .select()
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.type, 'Person')));

    actor = allLocal.find((a) => {
      const props = a.properties as Record<string, unknown> | null;
      return props?.oidcSub === sub && props?.oidcIssuer === config.oidcIssuer;
    });

    // Fall back to email match
    if (!actor && email) {
      actor = allLocal.find((a) => a.email === email);
      // Link the existing account to OIDC
      if (actor) {
        const existingProps = (actor.properties as Record<string, unknown> | null) ?? {};
        await db
          .update(actors)
          .set({
            properties: { ...existingProps, oidcSub: sub, oidcIssuer: config.oidcIssuer },
          })
          .where(eq(actors.id, actor.id));
      }
    }

    // Auto-provision new actor
    if (!actor) {
      const username = sanitizeUsername(
        (claims.preferred_username as string) ?? email?.split('@')[0] ?? `user_${sub.slice(0, 8)}`,
      );

      // Ensure username uniqueness
      let finalUsername = username;
      let suffix = 1;
      while (
        allLocal.some((a) => a.preferredUsername === finalUsername)
      ) {
        finalUsername = `${username}${suffix++}`;
      }

      const actorUri = `${protocol}://${config.domain}/users/${finalUsername}`;
      const isFirst = allLocal.length === 0;

      const [created] = await db
        .insert(actors)
        .values({
          type: 'Person',
          preferredUsername: finalUsername,
          displayName: name ?? finalUsername,
          email: email ?? null,
          uri: actorUri,
          inboxUri: `${actorUri}/inbox`,
          outboxUri: `${actorUri}/outbox`,
          followersUri: `${actorUri}/followers`,
          followingUri: `${actorUri}/following`,
          local: true,
          properties: {
            oidcSub: sub,
            oidcIssuer: config.oidcIssuer,
            ...(isFirst ? { instanceAdmin: true } : {}),
          },
        })
        .returning();
      actor = created;
    }

    // Create session (same as password login)
    await fastify.createSession(actor.id, reply);
    return reply.redirect('/');
  });
}

function sanitizeUsername(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32) || 'user';
}
