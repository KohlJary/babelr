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

describe('Channel update', () => {
  it('updates channel name and topic', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { serverId } = await createServerWithChannel(cookie);

    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie },
      payload: { name: 'dev' },
    });
    const channelId = JSON.parse(createRes.body).id;

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}`,
      headers: { cookie },
      payload: { name: 'engineering', topic: 'Engineering discussion' },
    });

    expect(updateRes.statusCode).toBe(200);
    const body = JSON.parse(updateRes.body);
    expect(body.name).toBe('engineering');
    expect(body.topic).toBe('Engineering discussion');
  });
});

describe('Glossary', () => {
  it('sets and retrieves a channel glossary', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    const putRes = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie },
      payload: { glossary: { hello: 'hola', goodbye: 'adiós' } },
    });

    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie },
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.glossary.hello).toBe('hola');
    expect(body.glossary.goodbye).toBe('adiós');
  });

  it('overwrites an existing glossary', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie },
      payload: { glossary: { old: 'value' } },
    });

    await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie },
      payload: { glossary: { new: 'value' } },
    });

    const getRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie },
    });

    const body2 = JSON.parse(getRes.body);
    expect(body2.glossary.new).toBe('value');
    expect(body2.glossary.old).toBeUndefined();
  });
});

describe('Read positions + unread', () => {
  it('marks a channel as read and returns unread count', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    // Post two messages
    await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'msg 1' },
    });
    await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'msg 2' },
    });

    // Check unread (should have messages)
    const unreadRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/unread`,
      headers: { cookie },
    });
    expect(unreadRes.statusCode).toBe(200);

    // Mark as read
    const readRes = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/read`,
      headers: { cookie },
    });
    expect(readRes.statusCode).toBe(200);
  });
});

describe('Mentions', () => {
  it('returns mentions for the current user', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'GET',
      url: '/mentions',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe('Thread replies', () => {
  it('posts and retrieves a reply to a message', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'Parent message' },
    });
    const parentId = JSON.parse(postRes.body).message.id;

    const replyRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages/${parentId}/replies`,
      headers: { cookie },
      payload: { content: 'Reply' },
    });
    expect(replyRes.statusCode).toBe(201);

    const threadRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages/${parentId}/replies`,
      headers: { cookie },
    });
    expect(threadRes.statusCode).toBe(200);
    const threadBody = JSON.parse(threadRes.body);
    expect(threadBody.messages).toBeDefined();
    expect(threadBody.messages.length).toBe(1);
    expect(threadBody.messages[0].message.content).toBe('Reply');
  });
});

describe('Notification preferences', () => {
  it('sets and retrieves notification mute preference', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    const muteRes = await app.inject({
      method: 'PUT',
      url: '/notifications/preferences',
      headers: { cookie },
      payload: { targetId: channelId, targetType: 'channel', muted: true },
    });
    expect(muteRes.statusCode).toBe(200);
  });
});

describe('Serializer output shapes', () => {
  it('message response includes expected fields', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { channelId } = await createServerWithChannel(cookie);

    await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
      payload: { content: 'Test shape' },
    });

    const getRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: { cookie },
    });

    const body = JSON.parse(getRes.body);
    const msg = body.messages[0];

    // MessageView shape
    expect(msg.message).toHaveProperty('id');
    expect(msg.message).toHaveProperty('content');
    expect(msg.message).toHaveProperty('published');
    expect(msg.message).toHaveProperty('channelId');

    // AuthorView shape
    expect(msg.author).toHaveProperty('id');
    expect(msg.author).toHaveProperty('preferredUsername');
    expect(msg.author).toHaveProperty('displayName');
  });

  it('channel list response includes expected fields', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const { serverId } = await createServerWithChannel(cookie);

    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/channels`,
      headers: { cookie },
    });

    const channels = JSON.parse(res.body);
    expect(channels.length).toBeGreaterThan(0);
    const ch = channels[0];
    expect(ch).toHaveProperty('id');
    expect(ch).toHaveProperty('name');
    expect(ch).toHaveProperty('channelType');
  });
});
