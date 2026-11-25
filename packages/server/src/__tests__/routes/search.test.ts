// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { enc } from '../e2e-fixtures.ts';

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
});

async function publicServer(cookie: string, name = 'Search Server') {
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name },
  });
  const serverId = JSON.parse(serverRes.body).id as string;
  await app.inject({
    method: 'PUT',
    url: `/servers/${serverId}`,
    headers: { cookie },
    payload: { isPublic: true },
  });
  const channelsRes = await app.inject({
    method: 'GET',
    url: `/servers/${serverId}/channels`,
    headers: { cookie },
  });
  return { serverId, channelId: JSON.parse(channelsRes.body)[0].id as string };
}

async function post(cookie: string, channelId: string, content: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/channels/${channelId}/messages`,
    headers: { cookie },
    payload: { content },
  });
  expect(res.statusCode).toBe(201);
}

async function search(cookie: string, q: string, channelId?: string) {
  const params = new URLSearchParams({ q });
  if (channelId) params.set('channelId', channelId);
  const res = await app.inject({ method: 'GET', url: `/search?${params}`, headers: { cookie } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const contents = (body: { messages: Array<{ message: { content: string } }> }) =>
  body.messages.map((m) => m.message.content).sort();

describe('GET /search', () => {
  it('finds messages by text in a channel I can read', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await publicServer(cookie);
    await post(cookie, channelId, 'The kiln is firing tonight');
    await post(cookie, channelId, 'Glaze tests came out blue');

    const { status, body } = await search(cookie, 'kiln');
    expect(status).toBe(200);
    expect(contents(body)).toEqual(['The kiln is firing tonight']);

    // Stemming: "fires" matches "firing"
    expect(contents((await search(cookie, 'fires')).body)).toEqual(['The kiln is firing tonight']);
  });

  it('does not 500 on punctuation in the query', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await publicServer(cookie);
    await post(cookie, channelId, "alice's kiln");

    for (const q of ["alice's", 'kiln & | !', '"kiln"', 'a:b (c']) {
      const { status } = await search(cookie, q);
      expect(status, q).toBe(200);
    }
  });

  it("never returns messages from a server I'm not in", async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { channelId } = await publicServer(aliceCookie);
    await post(aliceCookie, channelId, 'secret kiln schedule');

    const { status, body } = await search(bobCookie, 'kiln');
    expect(status).toBe(200);
    expect(body.messages).toEqual([]);

    // Not by in: name either
    expect((await search(bobCookie, 'in:general')).body.messages).toEqual([]);
    // And an explicit channelId is refused
    expect((await search(bobCookie, 'kiln', channelId)).status).toBe(403);
  });

  it("leaves out private channels I'm not a member of", async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { serverId, channelId } = await publicServer(aliceCookie);
    const join = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bobCookie },
    });
    expect(join.statusCode).toBeLessThan(300);

    const privRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: aliceCookie },
      payload: { name: 'staff', isPrivate: true },
    });
    const privId = JSON.parse(privRes.body).id as string;
    await post(aliceCookie, privId, 'private kiln budget');
    await post(aliceCookie, channelId, 'public kiln notice');

    expect(contents((await search(bobCookie, 'kiln')).body)).toEqual(['public kiln notice']);
    expect(contents((await search(aliceCookie, 'kiln')).body)).toEqual([
      'private kiln budget',
      'public kiln notice',
    ]);
  });

  it('does not search DMs (they are end-to-end encrypted)', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');
    const dmRes = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });
    const dmId = JSON.parse(dmRes.body).id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: aliceCookie },
      payload: { content: 'kiln', properties: enc() },
    });
    expect(sent.statusCode).toBe(201);

    expect((await search(aliceCookie, 'kiln')).body.messages).toEqual([]);
  });

  it('applies from: and in: filters', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { serverId, channelId } = await publicServer(aliceCookie);
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bobCookie },
    });
    await post(aliceCookie, channelId, 'alice on the kiln');
    await post(bobCookie, channelId, 'bob on the kiln');

    expect(contents((await search(aliceCookie, 'kiln from:bob')).body)).toEqual([
      'bob on the kiln',
    ]);
    expect((await search(aliceCookie, 'in:general')).body.messages).toHaveLength(2);
    expect((await search(aliceCookie, 'in:nowhere')).body.messages).toEqual([]);
  });
});
