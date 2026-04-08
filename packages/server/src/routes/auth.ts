// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import * as argon2 from 'argon2';
import { eq, and, ne, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import type { RegisterInput, LoginInput, ActorProfile } from '@babelr/shared';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

function toProfile(actor: typeof actors.$inferSelect): ActorProfile {
  const props = actor.properties as Record<string, unknown> | null;
  return {
    id: actor.id,
    uri: actor.uri,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    preferredLanguage: actor.preferredLanguage ?? 'en',
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

    const [actor] = await db
      .insert(actors)
      .values({
        type: 'Person',
        preferredUsername: username,
        email,
        passwordHash,
        preferredLanguage: preferredLanguage ?? 'en',
        uri: baseUri,
        inboxUri: `${baseUri}/inbox`,
        outboxUri: `${baseUri}/outbox`,
        followersUri: `${baseUri}/followers`,
        followingUri: `${baseUri}/following`,
        local: true,
      })
      .returning();

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

    // Destroy any existing session before creating a new one (rotation)
    await fastify.destroySession(request, reply);
    await fastify.createSession(actor.id, reply);

    return toProfile(actor);
  });

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

  // Update profile (displayName, summary/bio, avatarUrl)
  fastify.put<{ Body: { displayName?: string; summary?: string; avatarUrl?: string } }>(
    '/auth/profile',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { displayName, summary, avatarUrl } = request.body;
      const updates: Record<string, unknown> = {};

      if (displayName !== undefined) updates.displayName = displayName || null;
      if (summary !== undefined) updates.summary = summary || null;

      if (avatarUrl !== undefined) {
        const currentProps = (request.actor.properties as Record<string, unknown>) ?? {};
        updates.properties = { ...currentProps, avatarUrl: avatarUrl || null };
      }

      if (Object.keys(updates).length > 0) {
        await db.update(actors).set(updates).where(eq(actors.id, request.actor.id));
      }

      // Return updated profile
      const [updated] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.actor.id))
        .limit(1);

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
}
