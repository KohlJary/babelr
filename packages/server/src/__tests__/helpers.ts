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
import messageRoutes from '../routes/messages.ts';
import channelSettingsRoutes from '../routes/channel-settings.ts';
import serverRoutes from '../routes/servers.ts';
import dmRoutes from '../routes/dms.ts';
import dmConsentRoutes from '../routes/dm-consent.ts';
import friendsRoutes from '../routes/friends.ts';
import eventRoutes from '../routes/events.ts';
import wikiRoutes from '../routes/wiki.ts';
import roleRoutes from '../routes/roles.ts';
import translateRoutes from '../routes/translate.ts';
import fileRoutes from '../routes/files.ts';
import auditRoutes from '../routes/audit.ts';
import agentRoutes from '../routes/agents.ts';
import serverAgentRoutes from '../routes/server-agents.ts';
import actorRoutes from '../federation/actor.ts';
import embedRoutes from '../routes/embeds.ts';
import pluginLoader from '../plugins/plugin-loader.ts';
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
  federationMode: 'open',
  federationDomains: [],
  mediasoupListenIp: '127.0.0.1',
  mediasoupRtcMinPort: 40000,
  mediasoupRtcMaxPort: 40099,
};

/** Every WS send the stubbed decorators were asked to make, in order.
 *  `to` is an actor id, a channel id prefixed `channel:`, or `*` for
 *  broadcastToAllSubscribers. Tests may clear it (`length = 0`). */
export const wsSent: Array<{ to: string; message: unknown }> = [];

/**
 * `plugins: true` also mounts the real plugin loader (the in-tree
 * plugins from registered.ts, with their migrations) and the embed
 * proxy, for tests of plugin routes and their access checks.
 * `actorProfiles: true` mounts the federation actor document route.
 */
export async function createTestApp(opts: { plugins?: boolean; actorProfiles?: boolean } = {}) {
  const db = createDb(testConfig.databaseUrl);

  const app = Fastify({ logger: false });
  // Every route the app mounts, for tests that walk the whole table
  // (e.g. the agent scope map's deny-by-default check).
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
      routes.push({ method: m, url: r.url });
    }
  });

  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('db', db);
        fastify.decorate('config', testConfig);
      },
      { name: 'db' },
    ),
  );

  app.register(fp(async () => {}, { name: 'config-plugin' }));

  // Stub broadcastToChannel (no WS in tests)
  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('broadcastToChannel', (channelId: string, message: unknown) => {
          wsSent.push({ to: `channel:${channelId}`, message });
        });
        fastify.decorate('broadcastToAllSubscribers', (message: unknown) => {
          wsSent.push({ to: '*', message });
        });
        fastify.decorate('broadcastToActor', (actorId: string, message: unknown) => {
          wsSent.push({ to: actorId, message });
        });
        fastify.decorate('wsSubscribe', () => {});
        fastify.decorate('wsUnsubscribe', () => {});
        fastify.decorate('wsUnsubscribeActor', (actorId: string, channelId: string) => {
          wsSent.push({ to: `unsubscribe:${actorId}`, message: { channelId } });
        });
        fastify.decorate('wsRemoveClient', () => {});
        fastify.decorate('voiceJoin', () => null);
        fastify.decorate('voiceLeave', () => null);
        fastify.decorate('voiceGetRoom', () => []);
        fastify.decorate('voiceBroadcastToRoom', () => {});
        fastify.decorate('deliverToGroupFollowers', async () => {});
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
  await app.register(messageRoutes);
  await app.register(channelSettingsRoutes);
  await app.register(serverRoutes);
  await app.register(dmRoutes);
  await app.register(dmConsentRoutes);
  await app.register(friendsRoutes);
  await app.register(eventRoutes);
  await app.register(wikiRoutes);
  await app.register(roleRoutes);
  await app.register(translateRoutes);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(fileRoutes);
  await app.register(auditRoutes);
  await app.register(agentRoutes);
  await app.register(serverAgentRoutes);
  if (opts.actorProfiles) {
    // GET /users/:username (the AS2 actor document), for Service tests.
    await app.register(actorRoutes);
  }
  if (opts.plugins) {
    await app.register(embedRoutes);
    await app.register(pluginLoader);
  }

  await app.ready();
  return { app, db, routes };
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
  await db.execute(
    sql`TRUNCATE sessions, activities, delivery_queue, collection_items, read_positions, reactions, notification_preferences, invites, server_role_assignments, server_roles, objects, actors CASCADE`,
  );
}
