// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import * as argon2 from 'argon2';
import { eq, and, ne, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import type { RegisterInput, LoginInput, ActorProfile } from '@babelr/shared';
import { lookupActorByHandle } from '../federation/resolve.ts';
import { broadcastActorUpdate } from '../federation/delivery.ts';
import { randomUUID, randomBytes } from 'crypto';
import { sendVerificationEmail, isEmailEnabled } from '../email.ts';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const SKIP_EMAIL_VERIFICATION = process.env.SKIP_EMAIL_VERIFICATION === 'true';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingChallenge {
  actorId: string;
  expires: Date;
}
const pending2faChallenges = new Map<string, PendingChallenge>();

function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(4).toString('hex').toUpperCase(),
  );
}

function toProfile(actor: typeof actors.$inferSelect): ActorProfile {
  const props = actor.properties as Record<string, unknown> | null;
  return {
    id: actor.id,
    uri: actor.uri,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    preferredLanguage: actor.preferredLanguage ?? 'en',
    emailVerified: actor.emailVerified ?? false,
    totpEnabled: actor.totpEnabled ?? false,
    avatarUrl: (props?.avatarUrl as string) ?? null,
    summary: actor.summary,
    createdAt: actor.createdAt,
  };
}

export default async function authRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const domain = fastify.config.domain;

  fastify.post<{ Body: RegisterInput }>('/auth/register', async (request, reply) => {
    const { username, email, password, preferredLanguage } = request.body;

    if (!USERNAME_RE.test(username)) {
      return reply.status(400).send({
        error: 'Username must be 3-32 characters, alphanumeric and underscores only',
      });
    }

    if (!email || !email.includes('@')) {
      return reply.status(400).send({ error: 'Valid email is required' });
    }

    if (!password || password.length < 12) {
      return reply.status(400).send({ error: 'Password must be at least 12 characters' });
    }

    // Check username uniqueness among local actors
    const [existing] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.preferredUsername, username), eq(actors.local, true)))
      .limit(1);

    if (existing) {
      return reply.status(409).send({ error: 'Username already taken' });
    }

    // Check email uniqueness
    const [existingEmail] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.email, email))
      .limit(1);

    if (existingEmail) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    const passwordHash = await argon2.hash(password);
    const protocol = fastify.config.secureCookies ? 'https' : 'http';
    const baseUri = `${protocol}://${domain}/users/${username}`;

    const skipVerification = SKIP_EMAIL_VERIFICATION || !isEmailEnabled();
    const token = skipVerification ? null : randomUUID();
    const tokenExpires = token
      ? new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS)
      : null;

    const [actor] = await db
      .insert(actors)
      .values({
        type: 'Person',
        preferredUsername: username,
        email,
        passwordHash,
        preferredLanguage: preferredLanguage ?? 'en',
        emailVerified: skipVerification,
        verificationToken: token,
        verificationTokenExpires: tokenExpires,
        uri: baseUri,
        inboxUri: `${baseUri}/inbox`,
        outboxUri: `${baseUri}/outbox`,
        followersUri: `${baseUri}/followers`,
        followingUri: `${baseUri}/following`,
        local: true,
      })
      .returning();

    if (token) {
      void sendVerificationEmail(email, token, fastify.config).catch((err) =>
        fastify.log.error({ err }, 'Failed to send verification email'),
      );
    }

    // First user becomes instance admin
    const [userCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(actors)
      .where(and(eq(actors.type, 'Person'), eq(actors.local, true)));

    if (userCount.count === 1) {
      const currentProps = (actor.properties as Record<string, unknown>) ?? {};
      await db
        .update(actors)
        .set({ properties: { ...currentProps, instanceAdmin: true } })
        .where(eq(actors.id, actor.id));

      // Auto-join default server as owner
      const [defaultServer] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.type, 'Group'), eq(actors.local, true)))
        .limit(1);

      if (defaultServer?.followersUri) {
        await db
          .insert(collectionItems)
          .values({
            collectionUri: defaultServer.followersUri,
            itemUri: actor.uri,
            itemId: actor.id,
            properties: { role: 'owner' },
          })
          .onConflictDoNothing();
      }

      fastify.log.info({ username: actor.preferredUsername }, 'First user registered as instance admin');
    }

    await fastify.createSession(actor.id, reply);

    return reply.status(201).send(toProfile(actor));
  });

  fastify.post<{ Body: LoginInput }>('/auth/login', async (request, reply) => {
    const { email, password } = request.body;

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const [actor] = await db
      .select()
      .from(actors)
      .where(and(eq(actors.email, email), eq(actors.local, true)))
      .limit(1);

    if (!actor || !actor.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await argon2.verify(actor.passwordHash, password);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // If 2FA is enabled, don't create a session yet — return a
    // challenge token so the client can prompt for the TOTP code.
    if (actor.totpEnabled) {
      const challengeToken = randomUUID();
      const expires = new Date(Date.now() + 5 * 60 * 1000);
      pending2faChallenges.set(challengeToken, {
        actorId: actor.id,
        expires,
      });
      return { twoFactorRequired: true, challengeToken };
    }

    // Destroy any existing session before creating a new one (rotation)
    await fastify.destroySession(request, reply);
    await fastify.createSession(actor.id, reply);

    return toProfile(actor);
  });

  // Change password
  fastify.put<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { currentPassword, newPassword } = request.body;

      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'Current and new passwords are required' });
      }

      if (newPassword.length < 12) {
        return reply.status(400).send({ error: 'New password must be at least 12 characters' });
      }

      if (!request.actor.passwordHash) {
        return reply.status(400).send({ error: 'No password set for this account' });
      }

      const valid = await argon2.verify(request.actor.passwordHash, currentPassword);
      if (!valid) {
        return reply.status(403).send({ error: 'Current password is incorrect' });
      }

      const newHash = await argon2.hash(newPassword);
      await db
        .update(actors)
        .set({ passwordHash: newHash })
        .where(eq(actors.id, request.actor.id));

      return { ok: true };
    },
  );

  fastify.post('/auth/logout', async (request, reply) => {
    await fastify.destroySession(request, reply);
    return { ok: true };
  });

  fastify.get('/auth/me', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    return toProfile(request.actor);
  });

  // List other users (for starting DMs)
  fastify.get('/users', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const users = await db
      .select()
      .from(actors)
      .where(and(eq(actors.type, 'Person'), eq(actors.local, true), ne(actors.id, request.actor.id)));

    return users.map((u) => ({
      id: u.id,
      preferredUsername: u.preferredUsername,
      displayName: u.displayName,
    }));
  });

  // Look up a user by handle (supports remote via WebFinger)
  fastify.post<{ Body: { handle: string } }>('/users/lookup', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const raw = (request.body?.handle ?? '').trim().replace(/^@/, '');
    if (!raw) return reply.status(400).send({ error: 'handle is required' });

    // Local username (no @domain) or @user@domain matching this instance
    const atIndex = raw.indexOf('@');
    if (atIndex === -1 || raw.slice(atIndex + 1) === domain) {
      const username = atIndex === -1 ? raw : raw.slice(0, atIndex);
      const [local] = await db
        .select()
        .from(actors)
        .where(
          and(eq(actors.preferredUsername, username), eq(actors.local, true), eq(actors.type, 'Person')),
        )
        .limit(1);
      if (!local) return reply.status(404).send({ error: 'User not found' });
      return {
        id: local.id,
        preferredUsername: local.preferredUsername,
        displayName: local.displayName,
        uri: local.uri,
      };
    }

    // Remote lookup via WebFinger
    const remote = await lookupActorByHandle(db, raw);
    if (!remote) return reply.status(404).send({ error: 'Remote user not found' });
    return {
      id: remote.id,
      preferredUsername: remote.preferredUsername,
      displayName: remote.displayName,
      uri: remote.uri,
    };
  });

  // Update profile (displayName, summary/bio, avatarUrl, preferredLanguage)
  fastify.put<{
    Body: {
      displayName?: string;
      summary?: string;
      avatarUrl?: string;
      preferredLanguage?: string;
    };
  }>(
    '/auth/profile',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { displayName, summary, avatarUrl, preferredLanguage } = request.body;
      const updates: Record<string, unknown> = {};

      if (displayName !== undefined) updates.displayName = displayName || null;
      if (summary !== undefined) updates.summary = summary || null;
      if (preferredLanguage !== undefined) updates.preferredLanguage = preferredLanguage;

      if (avatarUrl !== undefined) {
        const currentProps = (request.actor.properties as Record<string, unknown>) ?? {};
        updates.properties = { ...currentProps, avatarUrl: avatarUrl || null };
      }

      const federatableFieldsTouched =
        displayName !== undefined || summary !== undefined || avatarUrl !== undefined;

      if (Object.keys(updates).length > 0) {
        await db.update(actors).set(updates).where(eq(actors.id, request.actor.id));
      }

      // Return updated profile
      const [updated] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.actor.id))
        .limit(1);

      // Fan out Update(Actor) to every remote friend's inbox so
      // cross-instance friend lists reflect the new profile. Fire and
      // forget — federation failure shouldn't block the HTTP
      // response, and the delivery queue handles retries.
      if (federatableFieldsTouched) {
        broadcastActorUpdate(fastify, updated).catch((err) =>
          fastify.log.error({ err }, 'Actor update federation enqueue failed'),
        );
      }

      return toProfile(updated);
    },
  );

  // Store own public key for E2E encryption
  fastify.put<{ Body: { publicKey: JsonWebKey } }>('/auth/publickey', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { publicKey } = request.body;
    if (!publicKey) {
      return reply.status(400).send({ error: 'publicKey is required' });
    }

    const currentProps = (request.actor.properties as Record<string, unknown>) ?? {};
    await db
      .update(actors)
      .set({ properties: { ...currentProps, publicKey } })
      .where(eq(actors.id, request.actor.id));

    return { ok: true };
  });

  // Get a user's public key
  fastify.get<{ Params: { userId: string } }>(
    '/users/:userId/publickey',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const [user] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.params.userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const props = user.properties as Record<string, unknown> | null;
      return { publicKey: props?.publicKey ?? null };
    },
  );

  // --- Email verification ---

  fastify.get<{ Querystring: { token?: string } }>(
    '/auth/verify',
    async (request, reply) => {
      const { token } = request.query;
      if (!token) {
        return reply.status(400).send({ error: 'Token is required' });
      }

      const [actor] = await db
        .select()
        .from(actors)
        .where(eq(actors.verificationToken, token))
        .limit(1);

      if (!actor) {
        return reply.status(400).send({ error: 'Invalid or expired token' });
      }

      if (
        actor.verificationTokenExpires &&
        new Date() > actor.verificationTokenExpires
      ) {
        return reply.status(400).send({ error: 'Token has expired. Request a new one.' });
      }

      await db
        .update(actors)
        .set({
          emailVerified: true,
          verificationToken: null,
          verificationTokenExpires: null,
          updatedAt: new Date(),
        })
        .where(eq(actors.id, actor.id));

      // Redirect to the app — the client will see emailVerified: true
      // on the next getMe() call.
      const protocol = fastify.config.secureCookies ? 'https' : 'http';
      return reply.redirect(`${protocol}://${domain}/?verified=1`);
    },
  );

  fastify.post('/auth/resend-verification', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    if (request.actor.emailVerified) {
      return reply.status(400).send({ error: 'Email already verified' });
    }

    if (!isEmailEnabled()) {
      return reply.status(503).send({ error: 'Email sending is not configured' });
    }

    const token = randomUUID();
    const expires = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    await db
      .update(actors)
      .set({
        verificationToken: token,
        verificationTokenExpires: expires,
        updatedAt: new Date(),
      })
      .where(eq(actors.id, request.actor.id));

    if (request.actor.email) {
      void sendVerificationEmail(request.actor.email, token, fastify.config).catch(
        (err) => fastify.log.error({ err }, 'Failed to send verification email'),
      );
    }

    return { sent: true };
  });

  // --- Two-factor authentication (TOTP) ---

  fastify.post('/auth/2fa/setup', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
    if (request.actor.totpEnabled) {
      return reply.status(400).send({ error: '2FA is already enabled' });
    }

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Babelr',
      label: request.actor.preferredUsername,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    // Store the secret (not yet enabled — needs verification).
    await db
      .update(actors)
      .set({ totpSecret: secret.base32, updatedAt: new Date() })
      .where(eq(actors.id, request.actor.id));

    const otpauthUri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);

    return { otpauthUri, qrDataUrl, secret: secret.base32 };
  });

  fastify.post<{ Body: { code: string } }>(
    '/auth/2fa/verify',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (request.actor.totpEnabled) {
        return reply.status(400).send({ error: '2FA is already enabled' });
      }
      if (!request.actor.totpSecret) {
        return reply.status(400).send({ error: 'Call /auth/2fa/setup first' });
      }

      const { code } = request.body ?? {};
      if (!code) return reply.status(400).send({ error: 'Code is required' });

      const totp = new OTPAuth.TOTP({
        issuer: 'Babelr',
        label: request.actor.preferredUsername,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(request.actor.totpSecret),
      });

      const delta = totp.validate({ token: code, window: 1 });
      if (delta === null) {
        return reply.status(400).send({ error: 'Invalid code' });
      }

      const recoveryCodes = generateRecoveryCodes();
      const hashedCodes = await Promise.all(
        recoveryCodes.map((c) => argon2.hash(c)),
      );

      await db
        .update(actors)
        .set({
          totpEnabled: true,
          totpRecoveryCodes: hashedCodes,
          updatedAt: new Date(),
        })
        .where(eq(actors.id, request.actor.id));

      return { enabled: true, recoveryCodes };
    },
  );

  fastify.post<{ Body: { challengeToken: string; code: string } }>(
    '/auth/2fa/challenge',
    async (request, reply) => {
      const { challengeToken, code } = request.body ?? {};
      if (!challengeToken || !code) {
        return reply.status(400).send({ error: 'challengeToken and code are required' });
      }

      const challenge = pending2faChallenges.get(challengeToken);
      if (!challenge || new Date() > challenge.expires) {
        pending2faChallenges.delete(challengeToken);
        return reply.status(400).send({ error: 'Challenge expired or invalid' });
      }
      pending2faChallenges.delete(challengeToken);

      const [actor] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, challenge.actorId))
        .limit(1);

      if (!actor || !actor.totpSecret) {
        return reply.status(400).send({ error: 'Invalid state' });
      }

      // Try TOTP code first.
      const totp = new OTPAuth.TOTP({
        issuer: 'Babelr',
        label: actor.preferredUsername,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(actor.totpSecret),
      });

      let valid = totp.validate({ token: code, window: 1 }) !== null;

      // If TOTP didn't match, try recovery codes.
      if (!valid) {
        const stored = (actor.totpRecoveryCodes as string[]) ?? [];
        for (let i = 0; i < stored.length; i++) {
          if (await argon2.verify(stored[i], code)) {
            valid = true;
            // Consume the recovery code.
            const remaining = [...stored];
            remaining.splice(i, 1);
            await db
              .update(actors)
              .set({ totpRecoveryCodes: remaining, updatedAt: new Date() })
              .where(eq(actors.id, actor.id));
            break;
          }
        }
      }

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid code' });
      }

      await fastify.destroySession(request, reply);
      await fastify.createSession(actor.id, reply);

      return toProfile(actor);
    },
  );

  fastify.post<{ Body: { code: string } }>(
    '/auth/2fa/disable',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (!request.actor.totpEnabled) {
        return reply.status(400).send({ error: '2FA is not enabled' });
      }

      const { code } = request.body ?? {};
      if (!code) return reply.status(400).send({ error: 'Code is required' });

      const totp = new OTPAuth.TOTP({
        issuer: 'Babelr',
        label: request.actor.preferredUsername,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(request.actor.totpSecret!),
      });

      if (totp.validate({ token: code, window: 1 }) === null) {
        return reply.status(400).send({ error: 'Invalid code' });
      }

      await db
        .update(actors)
        .set({
          totpEnabled: false,
          totpSecret: null,
          totpRecoveryCodes: [],
          updatedAt: new Date(),
        })
        .where(eq(actors.id, request.actor.id));

      return { disabled: true };
    },
  );
}
