// SPDX-License-Identifier: MIT
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
import { reactions } from '../../db/schema/reactions.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  postToInbox,
  cleanDb,
} from './helpers.ts';
import { wsSent } from '../helpers.ts';
import { enc, encNote } from '../e2e-fixtures.ts';

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
        ...encNote(),
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

describe('A DM is reachable only through the consent gate', () => {
  it("a Note naming a local DM as its context (and no local 'to') is dropped", async () => {
    const alice = await createTestUser(app, 'alice');
    const carol = await createTestUser(app, 'carol');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: alice.cookie },
      payload: { participantId: carol.body.id },
    });
    const dmId = JSON.parse(dm.body).id as string;
    const [row] = await db.select().from(objects).where(eq(objects.id, dmId));
    const eve = await createRemoteActor(db, { username: 'eve', domain: 'evil.tower' });
    const noteId = `${eve.actor.uri}/notes/ctx-1`;
    const res = await postToInbox(
      app,
      '/inbox',
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/activity`,
        type: 'Create',
        actor: eve.actor.uri,
        to: [],
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: eve.actor.uri,
          content: 'hi',
          to: [],
          context: row.uri,
          ...encNote(),
        },
      },
      eve.actor.uri,
      eve.privateKeyPem,
    );
    expect(res.statusCode).toBe(202);
    const [stored] = await db.select().from(objects).where(eq(objects.uri, noteId));
    expect(stored).toBeUndefined();
  });

  it("a backdated second message doesn't slip past a pending request", async () => {
    const alice = await createTestUser(app, 'alice');
    await put(alice.cookie, '/auth/dm-settings', { dmPolicy: 'friends' });
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    expect(await remoteDM(bob, 'one')).not.toBeNull();
    const noteId = `${bob.actor.uri}/notes/backdated`;
    await postToInbox(
      app,
      '/users/alice/inbox',
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/activity`,
        type: 'Create',
        actor: bob.actor.uri,
        to: [ALICE_URI],
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: bob.actor.uri,
          content: 'two',
          to: [ALICE_URI],
          published: '2001-01-01T00:00:00Z',
          ...encNote(),
        },
      },
      bob.actor.uri,
      bob.privateKeyPem,
    );
    const [stored] = await db.select().from(objects).where(eq(objects.uri, noteId));
    expect(stored).toBeUndefined();
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
      payload: { content: 'come back', properties: enc() },
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

describe('Momus trial 2: federation', () => {
  async function leaveAs(remote: Awaited<ReturnType<typeof createRemoteActor>>, k: number) {
    return postToInbox(
      app,
      '/users/alice/inbox',
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${remote.actor.uri}/activities/leave-${k}-${Date.now()}`,
        type: 'Leave',
        actor: remote.actor.uri,
        to: [ALICE_URI],
        object: { type: 'OrderedCollection', id: 'http://remote.tower/dms/x', babelrDM: true },
      },
      remote.actor.uri,
      remote.privateKeyPem,
    );
  }

  it('Leave then Note keeps the pending one-message limit', async () => {
    const alice = await createTestUser(app, 'alice');
    await put(alice.cookie, '/auth/dm-settings', { dmPolicy: 'friends' });
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    expect(await remoteDM(bob, 'one')).not.toBeNull();
    for (let k = 0; k < 3; k++) {
      await leaveAs(bob, k);
      expect(await remoteDM(bob, `again ${k}`)).toBeNull();
    }
  });

  it("re-entry after Leave follows the recipient's policy now", async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    expect(await remoteDM(bob, 'hi')).not.toBeNull();
    await leaveAs(bob, 9);
    await put(alice.cookie, '/auth/dm-settings', { dmPolicy: 'nobody' });
    expect(await remoteDM(bob, 'back')).toBeNull();
  });

  it('a Like needs membership, and a block stops it', async () => {
    const alice = await createTestUser(app, 'alice');
    const carol = await createTestUser(app, 'carol');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    const eve = await createRemoteActor(db, { username: 'eve', domain: 'evil.tower' });
    // A DM alice shares with bob, and one with carol that neither remote is in.
    const fromBob = await remoteDM(bob, 'hi');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: alice.cookie },
      payload: { participantId: carol.body.id },
    });
    const dmId = JSON.parse(dm.body).id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: alice.cookie },
      payload: { content: 'private', properties: enc() },
    });
    const privateNote = JSON.parse(sent.body).message.id as string;
    const [pn] = await db.select().from(objects).where(eq(objects.id, privateNote));

    const like = (who: typeof bob, noteUri: string, k: string) =>
      postToInbox(
        app,
        '/inbox',
        {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${who.actor.uri}/likes/${k}`,
          type: 'Like',
          actor: who.actor.uri,
          object: { id: noteUri, emoji: '👍' },
        },
        who.actor.uri,
        who.privateKeyPem,
      );
    const count = async (noteId: string) =>
      (await db.select().from(reactions).where(eq(reactions.objectId, noteId))).length;

    await like(eve, pn.uri, 'e1');
    expect(await count(pn.id)).toBe(0);

    await put(alice.cookie, '/blocks', { actorId: bob.actor.id }, 'POST');
    await like(bob, fromBob!.uri, 'b1');
    expect(await count(fromBob!.id)).toBe(0);
  });
});
