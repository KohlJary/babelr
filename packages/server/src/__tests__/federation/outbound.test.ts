// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Outbound federation tests. Verify that route handlers enqueue
 * delivery activities when content is created/updated/deleted on
 * servers with remote followers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/schema/actors.ts';
import { collectionItems } from '../../db/schema/collections.ts';
import { deliveryQueue } from '../../db/schema/delivery-queue.ts';
import { ensureActorKeys } from '../../federation/keys.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  createTestServer,
  cleanDb,
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

/**
 * Helper: set up a server with a remote follower so outbound
 * federation is triggered. Returns the cookie, server, channel,
 * group actor, and remote follower.
 */
/** Wait for fire-and-forget async operations to settle. */
const tick = () => new Promise((r) => setTimeout(r, 100));

async function setupServerWithRemoteFollower() {
  const { cookie } = await createTestUser(app, 'admin');
  const { server, channel } = await createTestServer(app, cookie, 'Test Server');
  const { actor: remoteUser } = await createRemoteActor(db, {
    username: 'remote-bob',
    domain: 'remote.tower',
  });

  // Get the Group actor and ensure it has signing keys
  const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
  await ensureActorKeys(db, group);

  // Add remote user as a follower of the Group
  await db.insert(collectionItems).values({
    collectionUri: group.followersUri!,
    itemUri: remoteUser.uri,
    itemId: remoteUser.id,
  });

  return { cookie, server, channel, group, remoteUser };
}

describe('Outbound message federation', () => {
  it('enqueues Create(Note) when sending a message in a server channel', async () => {
    const { cookie, channel, remoteUser } = await setupServerWithRemoteFollower();

    await app.inject({
      method: 'POST',
      url: `/channels/${channel.id}/messages`,
      headers: { cookie },
      payload: { content: 'Hello federated world!' },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const noteDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      return act.type === 'Create';
    });

    expect(noteDelivery).toBeDefined();
    expect(noteDelivery!.recipientInboxUri).toBe(remoteUser.inboxUri);
  });

  it('enqueues Update(Note) when editing a message', async () => {
    const { cookie, channel, remoteUser } = await setupServerWithRemoteFollower();

    // Create a message first
    const createRes = await app.inject({
      method: 'POST',
      url: `/channels/${channel.id}/messages`,
      headers: { cookie },
      payload: { content: 'Original content' },
    });
    const message = JSON.parse(createRes.body);

    // Clear the queue from the Create
    await db.delete(deliveryQueue);

    // Edit the message
    await app.inject({
      method: 'PUT',
      url: `/channels/${channel.id}/messages/${message.message.id}`,
      headers: { cookie },
      payload: { content: 'Edited content' },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const updateDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      return act.type === 'Update';
    });

    expect(updateDelivery).toBeDefined();
  });

  it('enqueues Delete(Note) when deleting a message', async () => {
    const { cookie, channel } = await setupServerWithRemoteFollower();

    const createRes = await app.inject({
      method: 'POST',
      url: `/channels/${channel.id}/messages`,
      headers: { cookie },
      payload: { content: 'To be deleted' },
    });
    const message = JSON.parse(createRes.body);

    await db.delete(deliveryQueue);

    await app.inject({
      method: 'DELETE',
      url: `/channels/${channel.id}/messages/${message.message.id}`,
      headers: { cookie },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const deleteDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      return act.type === 'Delete';
    });

    expect(deleteDelivery).toBeDefined();
  });
});

describe('Outbound wiki federation', () => {
  it('enqueues Create(Article) when creating a wiki page', async () => {
    const { cookie, server, remoteUser } = await setupServerWithRemoteFollower();

    await app.inject({
      method: 'POST',
      url: `/servers/${server.id}/wiki/pages`,
      headers: { cookie },
      payload: { title: 'Fed Wiki Page', content: 'Wiki content' },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const articleDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      const obj = act.object as Record<string, unknown> | undefined;
      return act.type === 'Create' && obj?.type === 'Article';
    });

    expect(articleDelivery).toBeDefined();
    expect(articleDelivery!.recipientInboxUri).toBe(remoteUser.inboxUri);
  });
});

describe('Outbound event federation', () => {
  it('enqueues Create(Event) when creating a server event', async () => {
    const { cookie, server, remoteUser } = await setupServerWithRemoteFollower();

    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 90000000).toISOString();

    await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie },
      payload: {
        title: 'Fed Event',
        description: 'Event desc',
        startAt,
        endAt,
        ownerType: 'server',
        ownerId: server.id,
      },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const eventDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      const obj = act.object as Record<string, unknown> | undefined;
      return act.type === 'Create' && obj?.type === 'Event';
    });

    expect(eventDelivery).toBeDefined();
    expect(eventDelivery!.recipientInboxUri).toBe(remoteUser.inboxUri);
  });
});

describe('Outbound reaction federation', () => {
  it('enqueues Like when adding a reaction to a message', async () => {
    const { cookie, channel } = await setupServerWithRemoteFollower();

    // Create a message
    const createRes = await app.inject({
      method: 'POST',
      url: `/channels/${channel.id}/messages`,
      headers: { cookie },
      payload: { content: 'React to this' },
    });
    const message = JSON.parse(createRes.body);

    await db.delete(deliveryQueue);

    // Add a reaction
    await app.inject({
      method: 'POST',
      url: `/channels/${channel.id}/messages/${message.message.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '🎉' },
    });
    await tick();

    const items = await db.select().from(deliveryQueue);
    const likeDelivery = items.find((i) => {
      const act = i.activityJson as Record<string, unknown>;
      return act.type === 'Like';
    });

    expect(likeDelivery).toBeDefined();
  });
});
