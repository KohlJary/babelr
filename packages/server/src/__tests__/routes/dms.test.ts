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

describe('DM Routes', () => {
  it('starts a DM conversation', async () => {
    const { cookie: aliceCookie, body: alice } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');

    const res = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.participants.length).toBe(2);
    expect(body.participants.some((p: { id: string }) => p.id === alice.id)).toBe(true);
    expect(body.participants.some((p: { id: string }) => p.id === bob.id)).toBe(true);
  });

  it('returns existing DM instead of creating duplicate', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');

    const res1 = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });

    const res2 = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });

    expect(JSON.parse(res1.body).id).toBe(JSON.parse(res2.body).id);
  });

  it('sends and retrieves DM messages', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');

    const dmRes = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });
    const dmId = JSON.parse(dmRes.body).id;

    // Send a message
    const sendRes = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: aliceCookie },
      payload: { content: 'Hey Bob!' },
    });

    expect(sendRes.statusCode).toBe(201);

    // Retrieve messages
    const getRes = await app.inject({
      method: 'GET',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: aliceCookie },
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].message.content).toBe('Hey Bob!');
  });

  it('denies non-participants access to DM messages', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');
    const { cookie: charlieCookie } = await createTestUser(app, 'charlie');

    const dmRes = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });
    const dmId = JSON.parse(dmRes.body).id;

    // Charlie tries to read
    const res = await app.inject({
      method: 'GET',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: charlieCookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it('lists DM conversations', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { body: bob } = await createTestUser(app, 'bob');

    await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: bob.id },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/dms',
      headers: { cookie: aliceCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
  });

  it('prevents DMing yourself', async () => {
    const { cookie: aliceCookie, body: alice } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: aliceCookie },
      payload: { participantId: alice.id },
    });

    expect(res.statusCode).toBe(400);
  });
});
