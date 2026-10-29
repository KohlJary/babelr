// SPDX-License-Identifier: MIT
/**
 * Step 3e over federation: a remote DM (a Note addressed to a local
 * actor) must carry babelrEncrypted and a well-formed babelrIv, or it
 * is dropped before it can open a conversation. An Update to a DM Note
 * must stay encrypted under a fresh IV.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { createDb } from '../../db/index.ts';
import { objects } from '../../db/schema/objects.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  postToInbox,
  cleanDb,
} from './helpers.ts';
import { wsSent } from '../helpers.ts';
import { encNote, freshIv } from '../e2e-fixtures.ts';

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

const ALICE_URI = 'http://test.babelr.local/users/alice';
type Remote = Awaited<ReturnType<typeof createRemoteActor>>;

let n = 0;
async function send(remote: Remote, type: 'Create' | 'Update', object: Record<string, unknown>) {
  n += 1;
  const res = await postToInbox(
    app,
    '/users/alice/inbox',
    {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${remote.actor.uri}/activities/${n}-${Date.now()}`,
      type,
      actor: remote.actor.uri,
      to: [ALICE_URI],
      object: { type: 'Note', attributedTo: remote.actor.uri, to: [ALICE_URI], ...object },
    },
    remote.actor.uri,
    remote.privateKeyPem,
  );
  expect(res.statusCode).toBe(202);
}

async function note(uri: string) {
  const [row] = await db.select().from(objects).where(eq(objects.uri, uri));
  return row;
}

async function dmCount(cookie: string) {
  const res = await app.inject({ method: 'GET', url: '/dms', headers: { cookie } });
  return (JSON.parse(res.body) as unknown[]).length;
}

describe('Inbound DMs must be encrypted', () => {
  it('a plaintext remote DM is dropped, and opens no conversation', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    const id = `${bob.actor.uri}/notes/plain`;
    await send(bob, 'Create', { id, content: 'hello in the clear' });
    expect(await note(id)).toBeUndefined();
    expect(await dmCount(alice.cookie)).toBe(0);
  });

  it('a bad IV counts as plaintext', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    const id = `${bob.actor.uri}/notes/badiv`;
    await send(bob, 'Create', { id, content: 'x', babelrEncrypted: true, babelrIv: 'nope' });
    expect(await note(id)).toBeUndefined();
    expect(await dmCount(alice.cookie)).toBe(0);
  });

  it('an encrypted remote DM is stored with its IV', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    const id = `${bob.actor.uri}/notes/enc`;
    const marker = encNote();
    await send(bob, 'Create', { id, content: 'Y2lwaGVy', ...marker });
    const row = await note(id);
    expect(row?.properties).toMatchObject({ encrypted: true, iv: marker.babelrIv });
    expect(await dmCount(alice.cookie)).toBe(1);
  });

  it('an Update to a DM Note needs a fresh IV', async () => {
    await createTestUser(app, 'alice');
    const bob = await createRemoteActor(db, { username: 'bob', domain: 'remote.tower' });
    const id = `${bob.actor.uri}/notes/edit`;
    const marker = encNote();
    await send(bob, 'Create', { id, content: 'b2xk', ...marker });

    // Plaintext edit: refused.
    await send(bob, 'Update', { id, content: 'plain edit' });
    expect((await note(id)).content).toBe('b2xk');

    // Same IV: refused.
    await send(bob, 'Update', { id, content: 'bmV3', ...marker });
    expect((await note(id)).content).toBe('b2xk');

    // Fresh IV: stored, and the IV goes out with the WS update.
    const iv = freshIv();
    wsSent.length = 0;
    await send(bob, 'Update', { id, content: 'bmV3', babelrEncrypted: true, babelrIv: iv });
    const row = await note(id);
    expect(row.content).toBe('bmV3');
    expect(row.properties).toMatchObject({ encrypted: true, iv });
    const update = wsSent.find((w) => (w.message as { type: string }).type === 'message:updated')
      ?.message as { payload: Record<string, unknown> } | undefined;
    expect(update?.payload).toMatchObject({ encrypted: true, iv });
  });
});
