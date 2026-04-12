// SPDX-License-Identifier: Hippocratic-3.0
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import { createDb } from '../db/index.ts';
import authPlugin from '../plugins/auth.ts';
import healthRoutes from '../routes/health.ts';
import authRoutes from '../routes/auth.ts';
import channelRoutes from '../routes/channels.ts';
import serverRoutes from '../routes/servers.ts';
import dmRoutes from '../routes/dms.ts';
import friendsRoutes from '../routes/friends.ts';
import eventRoutes from '../routes/events.ts';
import wikiRoutes from '../routes/wiki.ts';
import roleRoutes from '../routes/roles.ts';
import translateRoutes from '../routes/translate.ts';
import fileRoutes from '../routes/files.ts';
import multipart from '@fastify/multipart';
import type { Config } from '../config.ts';
import { sql } from 'drizzle-orm';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://babelr:babelr@localhost:5432/babelr_test';

const testConfig: Config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: TEST_DB_URL,
  domain: 'test.babelr.local',
  sessionSecret: 'test-secret-not-for-production',
  secureCookies: false,
};

export async function createTestApp() {
  const db = createDb(testConfig.databaseUrl);

  const app = Fastify({ logger: false });

  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('db', db);
        fastify.decorate('config', testConfig);
      },
      { name: 'db' },
    ),
  );

  app.register(
    fp(async () => {}, { name: 'config-plugin' }),
  );

  // Stub broadcastToChannel (no WS in tests)
  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('broadcastToChannel', () => {});
        fastify.decorate('broadcastToActor', () => {});
        fastify.decorate('wsSubscribe', () => {});
        fastify.decorate('wsUnsubscribe', () => {});
        fastify.decorate('wsRemoveClient', () => {});
        fastify.decorate('voiceJoin', () => null);
        fastify.decorate('voiceLeave', () => false);
        fastify.decorate('voiceGetRoom', () => []);
        fastify.decorate('voiceBroadcastToRoom', () => {});
        fastify.decorate('voiceRelayToActor', () => false);
      },
      { name: 'ws', dependencies: ['db', 'config-plugin'] },
    ),
  );

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(channelRoutes);
  await app.register(serverRoutes);
  await app.register(dmRoutes);
  await app.register(friendsRoutes);
  await app.register(eventRoutes);
  await app.register(wikiRoutes);
  await app.register(roleRoutes);
  await app.register(translateRoutes);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(fileRoutes);

  await app.ready();
  return { app, db };
}

export async function createTestUser(
  app: ReturnType<typeof Fastify>,
  username: string,
  email?: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      username,
      email: email ?? `${username}@test.babelr.local`,
      password: 'test-password-12chars',
    },
  });

  const body = JSON.parse(res.body);
  // Extract just the cookie name=value (strip path/attributes)
  const rawCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie as string);
  const cookie = cookieStr?.split(';')[0] ?? '';

  return { body, cookie };
}

export async function cleanDb(db: ReturnType<typeof createDb>) {
  // Truncate all tables in dependency order
  await db.execute(sql`TRUNCATE sessions, activities, delivery_queue, collection_items, read_positions, reactions, notification_preferences, invites, server_role_assignments, server_roles, objects, actors CASCADE`);
}
