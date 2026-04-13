// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { deliveryQueue } from '../../db/schema/delivery-queue.ts';
import { actors } from '../../db/schema/actors.ts';
import { enqueueDelivery, processQueue } from '../../federation/delivery.ts';
import { ensureActorKeys } from '../../federation/keys.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  cleanDb,
  testConfig,
} from './helpers.ts';

let app: FastifyInstance;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createFederationTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

describe('enqueueDelivery', () => {
  it('inserts a pending delivery item into the queue', async () => {
    const { body: alice } = await createTestUser(app, 'alice');
    const { actor: bob } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const activity = { type: 'Create', actor: alice.uri, object: { type: 'Note', content: 'test' } };
    await enqueueDelivery(db, activity, bob.inboxUri, alice.id);

    const items = await db.select().from(deliveryQueue);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('pending');
    expect(items[0].recipientInboxUri).toBe(bob.inboxUri);
    expect(items[0].senderActorId).toBe(alice.id);
  });
});

describe('processQueue', () => {
  it('marks deliveries as failed when sender has no signing key', async () => {
    const { body: alice } = await createTestUser(app, 'alice');
    const { actor: bob } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    // Remove alice's private key so signing fails
    await db.update(actors).set({ privateKeyPem: null }).where(eq(actors.id, alice.id));

    const activity = { type: 'Test', actor: alice.uri };
    await enqueueDelivery(db, activity, bob.inboxUri, alice.id);

    await processQueue(app);

    const [item] = await db.select().from(deliveryQueue);
    expect(item.status).toBe('failed');
    expect(item.lastError).toContain('no signing key');
  });

  it('skips delivery to blocked domains in blocklist mode', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    // Get alice's actor
    const meRes = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const alice = JSON.parse(meRes.body);

    // Ensure alice has signing keys
    const [aliceActor] = await db.select().from(actors).where(eq(actors.id, alice.id));
    await ensureActorKeys(db, aliceActor);

    const { actor: eve } = await createRemoteActor(db, {
      username: 'eve',
      domain: 'evil.tower',
    });

    const origMode = testConfig.federationMode;
    const origDomains = testConfig.federationDomains;
    testConfig.federationMode = 'blocklist';
    testConfig.federationDomains = ['evil.tower'];

    try {
      const activity = { type: 'Test', actor: alice.uri };
      await enqueueDelivery(db, activity, eve.inboxUri, alice.id);

      await processQueue(app);

      const [item] = await db.select().from(deliveryQueue);
      expect(item.status).toBe('failed');
      expect(item.lastError).toContain('domain not allowed');
    } finally {
      testConfig.federationMode = origMode;
      testConfig.federationDomains = origDomains;
    }
  });

  it('retries failed deliveries with backoff', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const meRes = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const alice = JSON.parse(meRes.body);
    const [aliceActor] = await db.select().from(actors).where(eq(actors.id, alice.id));
    await ensureActorKeys(db, aliceActor);

    const { actor: bob } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'unreachable.tower',
    });

    // Mock fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    try {
      const activity = { type: 'Test', actor: alice.uri };
      await enqueueDelivery(db, activity, bob.inboxUri, alice.id);

      await processQueue(app);

      const [item] = await db.select().from(deliveryQueue);
      expect(item.status).toBe('pending'); // Still pending, will retry
      expect(item.attempts).toBe(1);
      expect(item.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks delivery as delivered on success', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const meRes = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const alice = JSON.parse(meRes.body);
    const [aliceActor] = await db.select().from(actors).where(eq(actors.id, alice.id));
    await ensureActorKeys(db, aliceActor);

    const { actor: bob } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    // Mock fetch to return success
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));

    try {
      const activity = { type: 'Test', actor: alice.uri };
      await enqueueDelivery(db, activity, bob.inboxUri, alice.id);

      await processQueue(app);

      const [item] = await db.select().from(deliveryQueue);
      expect(item.status).toBe('delivered');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
