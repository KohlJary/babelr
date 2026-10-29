// SPDX-License-Identifier: MIT
/**
 * Step 3e: DMs are end-to-end encrypted, and the server refuses
 * plaintext there, on every path that writes a DM message: the DM and
 * channel POST routes, thread replies, and edits (which must bring a
 * fresh IV). Server channels are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { objects } from '../../db/schema/objects.ts';
import { DM_EDIT_IV_REUSED, DM_NOT_ENCRYPTED } from '../../e2e-policy.ts';
import { enc, freshIv } from '../e2e-fixtures.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp();
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

async function call(cookie: string, method: 'POST' | 'PUT' | 'GET', url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: { cookie }, payload });
  const body = JSON.parse(res.body || 'null');
  // Thrown refusals reach the test app as Fastify's default envelope
  // ({ error: 'Bad Request', message }); the real app maps them to
  // { error: message }. Read the reason from either.
  const reason = body?.message ?? body?.error;
  return { status: res.statusCode, body, reason };
}

async function setupDM() {
  const alice = await createTestUser(app, 'alice');
  const bob = await createTestUser(app, 'bob');
  const dm = await call(alice.cookie, 'POST', '/dms', { participantId: bob.body.id });
  expect(dm.status).toBe(201);
  return { alice, bob, dmId: dm.body.id as string };
}

async function postEncrypted(cookie: string, dmId: string, content = 'Y2lwaGVy') {
  const props = enc();
  const res = await call(cookie, 'POST', `/dms/${dmId}/messages`, { content, properties: props });
  expect(res.status).toBe(201);
  return { id: res.body.message.id as string, iv: props.iv };
}

async function stored(id: string) {
  const [row] = await db.select().from(objects).where(eq(objects.id, id));
  return row;
}

describe('DMs refuse plaintext', () => {
  it('a plaintext DM post is refused on the DM route', async () => {
    const { alice, dmId } = await setupDM();
    const res = await call(alice.cookie, 'POST', `/dms/${dmId}/messages`, { content: 'hello' });
    expect(res.status).toBe(400);
    expect(res.reason).toBe(DM_NOT_ENCRYPTED);
  });

  it('a plaintext DM post is refused on the channel route', async () => {
    const { alice, dmId } = await setupDM();
    const res = await call(alice.cookie, 'POST', `/channels/${dmId}/messages`, {
      content: 'hello',
    });
    expect(res.status).toBe(400);
    expect(res.reason).toBe(DM_NOT_ENCRYPTED);
  });

  it('a malformed IV or a bare encrypted flag counts as plaintext', async () => {
    const { alice, dmId } = await setupDM();
    for (const properties of [
      { encrypted: true },
      { encrypted: true, iv: 'short' },
      { iv: freshIv() },
      { encrypted: 'true', iv: freshIv() },
    ]) {
      const res = await call(alice.cookie, 'POST', `/dms/${dmId}/messages`, {
        content: 'hello',
        properties,
      });
      expect(res.status).toBe(400);
    }
    const all = await db.select().from(objects).where(eq(objects.context, dmId));
    expect(all).toHaveLength(0);
  });

  it('an encrypted DM post is stored with its IV', async () => {
    const { alice, dmId } = await setupDM();
    const { id, iv } = await postEncrypted(alice.cookie, dmId);
    const row = await stored(id);
    expect(row.properties).toMatchObject({ encrypted: true, iv });
  });

  it('a plaintext DM thread reply is refused; an encrypted one is stored with its IV', async () => {
    const { alice, bob, dmId } = await setupDM();
    const parent = await postEncrypted(alice.cookie, dmId);
    const url = `/channels/${dmId}/messages/${parent.id}/replies`;

    const plain = await call(bob.cookie, 'POST', url, { content: 'reply' });
    expect(plain.status).toBe(400);
    expect(plain.reason).toBe(DM_NOT_ENCRYPTED);

    const props = enc();
    const ok = await call(bob.cookie, 'POST', url, { content: 'cmVwbHk=', properties: props });
    expect(ok.status).toBe(201);
    expect(ok.body.message.properties).toMatchObject({ encrypted: true, iv: props.iv });
    expect((await stored(ok.body.message.id)).inReplyTo).toBe(parent.id);
  });

  it('a reply takes no attachments or provenance from the client', async () => {
    const { alice, bob, dmId } = await setupDM();
    const parent = await postEncrypted(alice.cookie, dmId);
    const res = await call(bob.cookie, 'POST', `/channels/${dmId}/messages/${parent.id}/replies`, {
      content: 'cmVwbHk=',
      properties: {
        ...enc(),
        authorKind: 'agent',
        attachments: [
          {
            url: '/uploads/00000000-0000-0000-0000-000000000000.png',
            filename: 'a.png',
            contentType: 'image/png',
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const props = (await stored(res.body.message.id)).properties as Record<string, unknown>;
    expect(props.authorKind).toBe('person');
    expect(props.attachments).toBeUndefined();
    expect(props.encrypted).toBe(true);
  });
});

describe('DM edits need a fresh IV', () => {
  it('an edit without a new IV is refused, and nothing changes', async () => {
    const { alice, dmId } = await setupDM();
    const msg = await postEncrypted(alice.cookie, dmId, 'b2xk');
    const url = `/channels/${dmId}/messages/${msg.id}`;

    const res = await call(alice.cookie, 'PUT', url, { content: 'plaintext edit' });
    expect(res.status).toBe(400);
    expect(res.reason).toBe(DM_NOT_ENCRYPTED);
    const row = await stored(msg.id);
    expect(row.content).toBe('b2xk');
    expect(row.properties).toMatchObject({ encrypted: true, iv: msg.iv });
  });

  it('an edit reusing the stored IV is refused', async () => {
    const { alice, dmId } = await setupDM();
    const msg = await postEncrypted(alice.cookie, dmId, 'b2xk');
    const res = await call(alice.cookie, 'PUT', `/channels/${dmId}/messages/${msg.id}`, {
      content: 'bmV3',
      properties: { encrypted: true, iv: msg.iv },
    });
    expect(res.status).toBe(400);
    expect(res.reason).toBe(DM_EDIT_IV_REUSED);
    expect((await stored(msg.id)).content).toBe('b2xk');
  });

  it('an edit with a fresh IV is stored, keeps provenance, and broadcasts the IV', async () => {
    const { alice, dmId } = await setupDM();
    const msg = await postEncrypted(alice.cookie, dmId, 'b2xk');
    const iv = freshIv();
    wsSent.length = 0;
    const res = await call(alice.cookie, 'PUT', `/channels/${dmId}/messages/${msg.id}`, {
      content: 'bmV3',
      // The client can't rewrite provenance through an edit.
      properties: { encrypted: true, iv, authorKind: 'agent' },
    });
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual({ encrypted: true, iv });

    const row = await stored(msg.id);
    expect(row.content).toBe('bmV3');
    expect(row.properties).toMatchObject({ encrypted: true, iv, authorKind: 'person' });

    const update = wsSent.find((w) => (w.message as { type: string }).type === 'message:updated')
      ?.message as { payload: Record<string, unknown> } | undefined;
    expect(update?.payload).toMatchObject({ messageId: msg.id, encrypted: true, iv });
  });
});

describe('Server channels are unchanged', () => {
  async function serverChannel(cookie: string) {
    const srv = await call(cookie, 'POST', '/servers', { name: 'Test Server' });
    const channels = await call(cookie, 'GET', `/servers/${srv.body.id}/channels`);
    return channels.body[0].id as string;
  }

  it('plaintext posts, replies and edits still work outside DMs', async () => {
    const alice = await createTestUser(app, 'alice');
    const channelId = await serverChannel(alice.cookie);

    const post = await call(alice.cookie, 'POST', `/channels/${channelId}/messages`, {
      content: 'hello',
    });
    expect(post.status).toBe(201);
    const id = post.body.message.id as string;

    const reply = await call(
      alice.cookie,
      'POST',
      `/channels/${channelId}/messages/${id}/replies`,
      {
        content: 'a reply',
      },
    );
    expect(reply.status).toBe(201);

    const edit = await call(alice.cookie, 'PUT', `/channels/${channelId}/messages/${id}`, {
      content: 'edited',
      // Ignored outside DMs, as before.
      properties: { encrypted: true, iv: freshIv() },
    });
    expect(edit.status).toBe(200);
    const row = await stored(id);
    expect(row.content).toBe('edited');
    expect((row.properties as Record<string, unknown>).encrypted).toBeUndefined();
  });
});
