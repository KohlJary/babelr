// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';

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

async function createServerWithChannel(cookie: string) {
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name: 'Test Server' },
  });
  const serverId = JSON.parse(serverRes.body).id;

  // Get the auto-created #general channel
  const channelsRes = await app.inject({
    method: 'GET',
    url: `/servers/${serverId}/channels`,
    headers: { cookie },
  });
  const channels = JSON.parse(channelsRes.body);
  return { serverId, channelId: channels[0].id };
}

describe('Channel Routes', () => {
  it('creates a channel in a server', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { serverId } = await createServerWithChannel(cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie },
      payload: { name: 'dev' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).name).toBe('dev');
  });

  it('posts and retrieves messages', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    // Post a message
    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'Hello, world!' },
    });

    expect(postRes.statusCode).toBe(201);

    // Retrieve messages
    const getRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].message.content).toBe('Hello, world!');
  });

  it('edits own messages', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'Original' },
    });
    const messageId = JSON.parse(postRes.body).message.id;

    const editRes = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${messageId}`,
      headers: { cookie },
      payload: { content: 'Edited' },
    });

    expect(editRes.statusCode).toBe(200);
    expect(JSON.parse(editRes.body).content).toBe('Edited');
  });

  it('prevents editing other users messages', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { serverId, channelId } = await createServerWithChannel(aliceCookie);

    // Bob joins the server
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bobCookie },
    });

    // Alice posts
    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: aliceCookie },
      payload: { content: "Alice's message" },
    });
    const messageId = JSON.parse(postRes.body).message.id;

    // Bob tries to edit
    const editRes = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${messageId}`,
      headers: { cookie: bobCookie },
      payload: { content: 'Hacked' },
    });

    expect(editRes.statusCode).toBe(403);
  });

  it('deletes own messages (tombstone)', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'Delete me' },
    });
    const messageId = JSON.parse(postRes.body).message.id;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${messageId}`,
      headers: { cookie },
    });

    expect(deleteRes.statusCode).toBe(200);

    // Message should not appear in listing (it's a Tombstone now)
    const getRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
    });

    const messages = JSON.parse(getRes.body).messages;
    expect(messages.length).toBe(0);
  });

  it('denies non-members access to channel messages', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { channelId } = await createServerWithChannel(aliceCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: bobCookie },
    });

    expect(res.statusCode).toBe(403);
  });
});
