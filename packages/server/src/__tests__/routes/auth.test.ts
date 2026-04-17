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

describe('Profile', () => {
  it('updates display name and language', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/profile',
      headers: { cookie },
      payload: { displayName: 'Alice W', preferredLanguage: 'fr' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.displayName).toBe('Alice W');
    expect(body.preferredLanguage).toBe('fr');
  });
});

describe('Password change', () => {
  it('changes password with valid current password', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/password',
      headers: { cookie },
      payload: {
        currentPassword: 'test-password-12chars',
        newPassword: 'new-password-12chars',
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects wrong current password', async () => {
    const { cookie } = await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/password',
      headers: { cookie },
      payload: {
        currentPassword: 'wrong-password-12chars',
        newPassword: 'new-password-12chars',
      },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('Email verification', () => {
  it('registration returns emailVerified field', async () => {
    const { body } = await createTestUser(app, 'verifytest');
    expect(body).toHaveProperty('emailVerified');
  });

  it('resend-verification requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('2FA setup + challenge', () => {
  it('setup returns QR code and secret', async () => {
    const { cookie } = await createTestUser(app, 'tfauser');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/2fa/setup',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('qrDataUrl');
    expect(body).toHaveProperty('secret');
    expect(body).toHaveProperty('otpauthUri');
    expect(body.secret.length).toBeGreaterThan(10);
  });

  it('verify rejects invalid code', async () => {
    const { cookie } = await createTestUser(app, 'tfauser2');

    await app.inject({
      method: 'POST',
      url: '/auth/2fa/setup',
      headers: { cookie },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      headers: { cookie },
      payload: { code: '000000' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('disable rejects when 2FA not enabled', async () => {
    const { cookie } = await createTestUser(app, 'tfauser3');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: { cookie },
      payload: { code: '000000' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('challenge rejects invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/2fa/challenge',
      payload: { challengeToken: 'invalid', code: '000000' },
    });

    expect(res.statusCode).toBe(400);
  });
});
