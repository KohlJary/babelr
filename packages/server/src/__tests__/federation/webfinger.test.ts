// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { createDb } from '../../db/index.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  cleanDb,
} from './helpers.ts';

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
});

describe('WebFinger', () => {
  it('resolves a local Person actor', async () => {
    await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=acct:alice@test.babelr.local',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subject).toBe('acct:alice@test.babelr.local');
    expect(body.links).toHaveLength(1);
    expect(body.links[0].rel).toBe('self');
    expect(body.links[0].type).toBe('application/activity+json');
    expect(body.links[0].href).toContain('/users/alice');
  });

  it('resolves a local Group actor', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    // Create a server (Group)
    await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie },
      payload: { name: 'Test Server', description: 'A test group' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=acct:test-server@test.babelr.local',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subject).toBe('acct:test-server@test.babelr.local');
    expect(body.links[0].href).toContain('/groups/');
  });

  it('returns 404 for unknown user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=acct:nobody@test.babelr.local',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for wrong domain', async () => {
    await createTestUser(app, 'alice');

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=acct:alice@other-tower.com',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for missing resource parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid resource format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=not-an-acct-uri',
    });

    expect(res.statusCode).toBe(400);
  });

  it('does not resolve remote actors', async () => {
    await createRemoteActor(db, { username: 'bob', domain: 'remote.tower.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/webfinger?resource=acct:bob@remote.tower.com',
    });

    // Should 404 — WebFinger only serves local actors
    expect(res.statusCode).toBe(404);
  });
});
