// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import * as argon2 from 'argon2';
import { eq, and, ne } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import type { RegisterInput, LoginInput, ActorProfile } from '@babelr/shared';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

function toProfile(actor: typeof actors.$inferSelect): ActorProfile {
  return {
    id: actor.id,
    uri: actor.uri,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    preferredLanguage: actor.preferredLanguage ?? 'en',
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
}
