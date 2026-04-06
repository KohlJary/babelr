// SPDX-License-Identifier: Hippocratic-3.0
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { sessions } from '../db/schema/sessions.ts';

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'babelr_sid';

async function authPlugin(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;

  // Session middleware: attach actor to request if valid session cookie exists
  fastify.decorateRequest('actor', undefined);
  fastify.addHook('onRequest', async (request) => {
    const sid = request.cookies[COOKIE_NAME];
    if (!sid) return;

    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sid, sid))
      .limit(1);

    if (!session || session.expiresAt < new Date()) {
      if (session) {
        await db.delete(sessions).where(eq(sessions.sid, sid));
      }
      return;
    }

    const [actor] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, session.actorId))
      .limit(1);

    if (actor) {
      request.actor = actor;
    }
  });

  // Helper: create session and set cookie
  fastify.decorate(
    'createSession',
    async (actorId: string, reply: FastifyReply) => {
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
    },
  );

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
