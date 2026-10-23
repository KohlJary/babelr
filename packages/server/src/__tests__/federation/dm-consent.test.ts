// SPDX-License-Identifier: Hippocratic-3.0
/**
 * DM consent over federation: inbound DMs from remote actors follow the
 * recipient's policy and blocks, leaving stops inbound delivery, and a
 * Leave travels both ways.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { createDb } from '../../db/index.ts';
import { objects } from '../../db/schema/objects.ts';
import { deliveryQueue } from '../../db/schema/delivery-queue.ts';
import { dmRequests } from '../../db/schema/dm-consent.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  postToInbox,
  cleanDb,
} from './helpers.ts';
import { wsSent } from '../helpers.ts';

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
  wsSent.length = 0;
});

const tick = () => new Promise((r) => setTimeout(r, 100));
const ALICE_URI = 'http://test.babelr.local/users/alice';

let n = 0;
async function remoteDM(
  remote: Awaited<ReturnType<typeof createRemoteActor>>,
  content: string,
  to = ALICE_URI,
) {
  n += 1;
  const noteId = `${remote.actor.uri}/notes/${n}-${Date.now()}`;
  const res = await postToInbox(
    app,
    '/users/alice/inbox',
    {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${noteId}/activity`,
      type: 'Create',
      actor: remote.actor.uri,
      to: [to],
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: remote.actor.uri,
        content,
        to: [to],
      },
    },
    remote.actor.uri,
    remote.privateKeyPem,
  );
  expect(res.statusCode).toBe(202);
  const [stored] = await db.select().from(objects).where(eq(objects.uri, noteId));
  return stored ?? null;
}

async function dmsOf(cookie: string, path = '/dms') {
  const res = await app.inject({ method: 'GET', url: path, headers: { cookie } });
  return JSON.parse(res.body) as Array<{
    id: string;
    participants: Array<{ id: string }>;
    left?: Array<{ id: string }>;
    request?: { state: string; incoming: boolean };
  }>;
}

async function put(cookie: string, url: string, payload: object, method = 'PUT') {
  return app.inject({ method: method as 'PUT', url, headers: { cookie }, payload });
}

describe('Inbound DMs respect DM consent', () => {
  it('policy nobody: a remote DM is dropped whole', async () => {
    const alice = await createTestUser(app, 'alice');
    await put(alice.cookie, '/auth/dm-settings', { dmPolicy: 'nobody' });
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });

    expect(await remoteDM(bob, 'hello')).toBeNull();
    expect(await dmsOf(alice.cookie)).toHaveLength(0);
    expect(await dmsOf(alice.cookie, '/dms/requests')).toHaveLength(0);
  });

  it('a block drops remote DMs, even in a conversation that already exists', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    expect(await remoteDM(bob, 'first')).not.toBeNull();
    expect(await dmsOf(alice.cookie)).toHaveLength(1);

    await put(alice.cookie, '/blocks', { actorId: bob.actor.id }, 'POST');
    expect(await remoteDM(bob, 'second')).toBeNull();
  });

  it('policy friends: a remote stranger lands as a request, with one message', async () => {
    const alice = await createTestUser(app, 'alice');
    await put(alice.cookie, '/auth/dm-settings', { dmPolicy: 'friends' });
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });

    expect(await remoteDM(bob, 'may I?')).not.toBeNull();
    expect(await dmsOf(alice.cookie)).toHaveLength(0);
    const reqs = await dmsOf(alice.cookie, '/dms/requests');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].request).toEqual({ state: 'pending', incoming: true });
    expect(wsSent).toContainEqual(
      expect.objectContaining({
        to: alice.body.id,
        message: expect.objectContaining({ type: 'dm:request' }),
      }),
    );
    // The second one before she answers is dropped.
    expect(await remoteDM(bob, 'hello??')).toBeNull();

    const [req] = await db.select().from(dmRequests).where(eq(dmRequests.fromId, bob.actor.id));
    expect(req.state).toBe('pending');
  });
});

describe('Leaving stops federation delivery', () => {
  it('after a local person leaves, remote messages are dropped and no new DM is made', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    await remoteDM(bob, 'hi alice');
    const [dm] = await dmsOf(alice.cookie);

    const leave = await app.inject({
      method: 'POST',
      url: `/dms/${dm.id}/leave`,
      headers: { cookie: alice.cookie },
    });
    expect(leave.statusCode).toBe(200);
    await tick();

    // Bob's tower is told, with a Leave addressed to him.
    const queued = await db
      .select()
      .from(deliveryQueue)
      .where(eq(deliveryQueue.recipientInboxUri, bob.actor.inboxUri));
    const leaveActivity = queued
      .map((q) => q.activityJson as Record<string, unknown>)
      .find((a) => a.type === 'Leave');
    expect(leaveActivity).toMatchObject({
      actor: ALICE_URI,
      to: [bob.actor.uri],
      object: expect.objectContaining({ babelrDM: true }),
    });

    // Nothing bob sends reaches alice any more, by any route.
    expect(await remoteDM(bob, 'are you there?')).toBeNull();
    expect(await dmsOf(alice.cookie)).toHaveLength(0);
    const notes = await db
      .select()
      .from(objects)
      .where(and(eq(objects.context, dm.id), eq(objects.type, 'Note')));
    expect(notes).toHaveLength(1);
  });

  it('a remote Leave marks the remote participant as left here', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    await remoteDM(bob, 'hi');
    const [dm] = await dmsOf(alice.cookie);

    const res = await postToInbox(
      app,
      '/users/alice/inbox',
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${bob.actor.uri}/activities/leave-1`,
        type: 'Leave',
        actor: bob.actor.uri,
        to: [ALICE_URI],
        object: { type: 'OrderedCollection', id: 'http://remote.tower/dms/x', babelrDM: true },
      },
      bob.actor.uri,
      bob.privateKeyPem,
    );
    expect(res.statusCode).toBe(202);

    const [after] = await dmsOf(alice.cookie);
    expect(after.id).toBe(dm.id);
    expect(after.left?.map((p) => p.id)).toEqual([bob.actor.id]);
    // Alice can't put bob back; posting there reaches nobody.
    const post = await app.inject({
      method: 'POST',
      url: `/dms/${dm.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { content: 'come back' },
    });
    expect(post.statusCode).toBe(403);
    const reopen = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: alice.cookie },
      payload: { participantId: bob.actor.id },
    });
    expect(reopen.statusCode).toBe(403);
  });
});
