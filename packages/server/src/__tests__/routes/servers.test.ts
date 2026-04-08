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

describe('Server Routes', () => {
  it('creates a server', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie },
      payload: { name: 'Test Server', description: 'A test server' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Test Server');
    expect(body.memberCount).toBe(1);
  });

  it('lists servers the user is a member of', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie },
      payload: { name: 'Server 1' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/servers',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Server 1');
  });

  it('allows joining a server', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');

    const createRes = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: aliceCookie },
      payload: { name: 'Open Server' },
    });
    const serverId = JSON.parse(createRes.body).id;

    const joinRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bobCookie },
    });

    expect(joinRes.statusCode).toBe(200);

    // Bob should see it in their server list
    const listRes = await app.inject({
      method: 'GET',
      url: '/servers',
      headers: { cookie: bobCookie },
    });

    const servers = JSON.parse(listRes.body);
    expect(servers.some((s: { id: string }) => s.id === serverId)).toBe(true);
  });

  it('allows leaving a server (non-owner)', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');

    const createRes = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: aliceCookie },
      payload: { name: 'Temp Server' },
    });
    const serverId = JSON.parse(createRes.body).id;

    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bobCookie },
    });

    const leaveRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/leave`,
      headers: { cookie: bobCookie },
    });

    expect(leaveRes.statusCode).toBe(200);
  });

  it('prevents owner from leaving', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const createRes = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie },
      payload: { name: 'My Server' },
    });
    const serverId = JSON.parse(createRes.body).id;

    const leaveRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/leave`,
      headers: { cookie },
    });

    expect(leaveRes.statusCode).toBe(400);
  });

  it('discovers all servers with join status', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');

    await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: aliceCookie },
      payload: { name: 'Discoverable' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/servers/discover',
      headers: { cookie: bobCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const server = body.find((s: { name: string }) => s.name === 'Discoverable');
    expect(server).toBeTruthy();
    expect(server.joined).toBe(false);
  });
});
