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

describe('Auth Routes', () => {
  it('registers a new user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'alice', email: 'alice@test.local', password: 'test-password-12chars' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.preferredUsername).toBe('alice');
    expect(body.id).toBeTruthy();
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('rejects short passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'alice', email: 'alice@test.local', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate usernames', async () => {
    await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'alice', email: 'alice2@test.local', password: 'test-password-12chars' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('logs in with valid credentials', async () => {
    await createTestUser(app, 'alice', 'alice@test.local');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@test.local', password: 'test-password-12chars' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.preferredUsername).toBe('alice');
  });

  it('rejects invalid credentials', async () => {
    await createTestUser(app, 'alice', 'alice@test.local');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@test.local', password: 'wrong-password-12chars' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns current user via /auth/me', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.preferredUsername).toBe('alice');
  });

  it('returns 401 for /auth/me without session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(res.statusCode).toBe(401);
  });

  it('logs out successfully', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });

    expect(logoutRes.statusCode).toBe(200);

    // Session should be invalid now
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });

    expect(meRes.statusCode).toBe(401);
  });
});
