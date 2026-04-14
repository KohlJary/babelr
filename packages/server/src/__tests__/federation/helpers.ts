// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Federation test helpers. Creates simulated remote actors with signing
 * keys and provides utilities to sign and inject activities into inbox
 * endpoints, bypassing real HTTP delivery.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';
import { createDb } from '../../db/index.ts';
import { actors } from '../../db/schema/actors.ts';
import { sql } from 'drizzle-orm';
import { generateActorKeypair } from '../../federation/keys.ts';
import { signRequest } from '../../federation/signatures.ts';
import type { Config } from '../../config.ts';

// Route imports
import authPlugin from '../../plugins/auth.ts';
import healthRoutes from '../../routes/health.ts';
import authRoutes from '../../routes/auth.ts';
import channelRoutes from '../../routes/channels.ts';
import serverRoutes from '../../routes/servers.ts';
import dmRoutes from '../../routes/dms.ts';
import friendsRoutes from '../../routes/friends.ts';
import eventRoutes from '../../routes/events.ts';
import wikiRoutes from '../../routes/wiki.ts';
import roleRoutes from '../../routes/roles.ts';
import fileRoutes from '../../routes/files.ts';
import auditRoutes from '../../routes/audit.ts';
import voiceRoutes from '../../routes/voice.ts';

// Federation route imports
import webfingerRoute from '../../federation/webfinger.ts';
import actorRoutes from '../../federation/actor.ts';
import inboxRoutes from '../../federation/inbox.ts';
import collectionRoutes from '../../federation/collections.ts';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://babelr:babelr@localhost:5432/babelr_test';

export const testConfig: Config = {
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

/**
 * Create a test app with federation routes registered (inbox, webfinger,
 * actor profiles, collections). Does NOT start the delivery queue processor.
 */
export async function createFederationTestApp() {
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

  app.register(fp(async () => {}, { name: 'config-plugin' }));

  // Stub WS/voice (no real WebSocket in tests)
  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('broadcastToChannel', () => {});
        fastify.decorate('broadcastToAllSubscribers', () => {});
        fastify.decorate('broadcastToActor', () => {});
        fastify.decorate('wsSubscribe', () => {});
        fastify.decorate('wsUnsubscribe', () => {});
        fastify.decorate('wsRemoveClient', () => {});
        fastify.decorate('voiceJoin', () => null);
        fastify.decorate('voiceLeave', () => null);
        fastify.decorate('voiceGetRoom', () => []);
        fastify.decorate('voiceBroadcastToRoom', () => {});
      },
      { name: 'ws', dependencies: ['db', 'config-plugin'] },
    ),
  );

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });

  // ActivityPub content-type parser (same as app.ts)
  const jsonParser = app.getDefaultJsonParser('ignore', 'ignore');
  app.addContentTypeParser('application/activity+json', { parseAs: 'string' }, jsonParser);
  app.addContentTypeParser('application/ld+json', { parseAs: 'string' }, jsonParser);

  await app.register(authPlugin);

  // Core routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(channelRoutes);
  await app.register(serverRoutes);
  await app.register(dmRoutes);
  await app.register(friendsRoutes);
  await app.register(eventRoutes);
  await app.register(wikiRoutes);
  await app.register(roleRoutes);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(fileRoutes);
  await app.register(auditRoutes);
  await app.register(voiceRoutes);

  // Federation routes (the key difference from the basic test app)
  await app.register(webfingerRoute);
  await app.register(actorRoutes);
  await app.register(inboxRoutes);
  await app.register(collectionRoutes);

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
  const rawCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie as string);
  const cookie = cookieStr?.split(';')[0] ?? '';

  return { body, cookie };
}

/**
 * Create a simulated remote actor in the DB with signing keys.
 * Returns the actor record and the private key for signing activities.
 */
export async function createRemoteActor(
  db: ReturnType<typeof createDb>,
  opts: {
    username: string;
    domain: string;
    type?: 'Person' | 'Group';
    displayName?: string;
  },
) {
  const { publicKeyPem, privateKeyPem } = generateActorKeypair();
  const type = opts.type ?? 'Person';
  const prefix = type === 'Group' ? 'groups' : 'users';
  const uri = `http://${opts.domain}/${prefix}/${opts.username}`;

  const [actor] = await db
    .insert(actors)
    .values({
      type,
      preferredUsername: opts.username,
      displayName: opts.displayName ?? opts.username,
      uri,
      inboxUri: `${uri}/inbox`,
      outboxUri: `${uri}/outbox`,
      followersUri: `${uri}/followers`,
      followingUri: `${uri}/following`,
      local: false,
      privateKeyPem,
      properties: {
        apPublicKey: {
          id: `${uri}#main-key`,
          owner: uri,
          publicKeyPem,
        },
      },
    })
    .returning();

  return { actor, privateKeyPem, publicKeyPem };
}

/**
 * Sign an activity as a remote actor and inject it into an inbox endpoint.
 */
export async function postToInbox(
  app: ReturnType<typeof Fastify>,
  inboxPath: string,
  activity: Record<string, unknown>,
  signerUri: string,
  signerPrivateKey: string,
) {
  const body = JSON.stringify(activity);
  const url = `http://test.babelr.local${inboxPath}`;
  const { headers } = signRequest(
    signerPrivateKey,
    `${signerUri}#main-key`,
    'POST',
    url,
    body,
  );

  return app.inject({
    method: 'POST',
    url: inboxPath,
    headers: {
      'Content-Type': 'application/activity+json',
      ...headers,
    },
    payload: body,
  });
}

export async function cleanDb(db: ReturnType<typeof createDb>) {
  await db.execute(
    sql`TRUNCATE sessions, activities, delivery_queue, collection_items, read_positions, reactions, notification_preferences, invites, server_role_assignments, server_roles, wiki_page_links, wiki_page_revisions, wiki_pages, event_attendees, events, server_files, audit_logs, friendships, objects, actors CASCADE`,
  );
}

/**
 * Create a server (Group actor) owned by a local user.
 * Returns the server actor and a channel for testing message federation.
 */
export async function createTestServer(
  app: ReturnType<typeof Fastify>,
  cookie: string,
  name: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name, description: 'Test server' },
  });
  const server = JSON.parse(res.body);

  // Get the default channel
  const chRes = await app.inject({
    method: 'GET',
    url: `/servers/${server.id}/channels`,
    headers: { cookie },
  });
  const channels = JSON.parse(chRes.body);

  return { server, channel: channels[0] };
}
