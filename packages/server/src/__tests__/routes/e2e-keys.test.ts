// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/schema/actors.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp({ actorProfiles: true });
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

// The P-256 example key from RFC 7515 A.3, with the extra fields
// browsers add to an exported JWK.
const X = 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU';
const Y = 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0';
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: X, y: Y, ext: true, key_ops: [] };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function agentToken(cookie: string, scopes: string[]) {
  const a = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { username: 'robo', kind: 'agent', displayName: 'robo' },
  });
  expect(a.statusCode).toBe(201);
  const agentId = JSON.parse(a.body).id as string;
  const t = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/tokens`,
    headers: { cookie },
    payload: { name: 'test', scopes },
  });
  expect(t.statusCode).toBe(201);
  return { agentId, token: JSON.parse(t.body).token as string };
}

describe('PUT /auth/publickey', () => {
  it('stores only the public coordinates', async () => {
    const { cookie, body } = await createTestUser(app, 'pat');
    const put = await app.inject({
      method: 'PUT',
      url: '/auth/publickey',
      headers: { cookie },
      payload: { publicKey: PUBLIC_JWK },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET',
      url: `/users/${body.id}/publickey`,
      headers: { cookie },
    });
    expect(JSON.parse(get.body).publicKey).toEqual({ kty: 'EC', crv: 'P-256', x: X, y: Y });
  });

  it('refuses a private key, so nobody publishes theirs by accident', async () => {
    const { cookie } = await createTestUser(app, 'pat');
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/publickey',
      headers: { cookie },
      payload: { publicKey: { ...PUBLIC_JWK, d: X } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses anything that is not a P-256 public key', async () => {
    const { cookie } = await createTestUser(app, 'pat');
    for (const publicKey of [
      'not a key',
      { kty: 'RSA', n: 'x', e: 'AQAB' },
      { kty: 'EC', crv: 'P-384', x: X, y: Y },
      { kty: 'EC', crv: 'P-256', x: 'short', y: Y },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/auth/publickey',
        headers: { cookie },
        payload: { publicKey },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('agents and E2E keys', () => {
  it('an agent with keys:write can publish its key; without it, 403', async () => {
    const { cookie } = await createTestUser(app, 'kohl');
    const without = await agentToken(cookie, ['dms:read', 'dms:post']);
    const denied = await app.inject({
      method: 'PUT',
      url: '/auth/publickey',
      headers: bearer(without.token),
      payload: { publicKey: PUBLIC_JWK },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${without.agentId}/tokens`,
      headers: { cookie },
      payload: { name: 'keys', scopes: ['keys:write'] },
    });
    expect(res.statusCode).toBe(201);
    const ok = await app.inject({
      method: 'PUT',
      url: '/auth/publickey',
      headers: bearer(JSON.parse(res.body).token),
      payload: { publicKey: PUBLIC_JWK },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('any agent token can read a public key', async () => {
    const { cookie, body } = await createTestUser(app, 'kohl');
    await app.inject({
      method: 'PUT',
      url: '/auth/publickey',
      headers: { cookie },
      payload: { publicKey: PUBLIC_JWK },
    });
    const { token } = await agentToken(cookie, ['dms:read']);
    const res = await app.inject({
      method: 'GET',
      url: `/users/${body.id}/publickey`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).publicKey.x).toBe(X);
  });
});

describe('GET /users/:id/publickey', () => {
  it('never hands out a private part saved before PUT checked keys', async () => {
    const { cookie, body } = await createTestUser(app, 'pat');
    await db
      .update(actors)
      .set({ properties: { publicKey: { ...PUBLIC_JWK, d: X } } })
      .where(eq(actors.id, body.id));
    const res = await app.inject({
      method: 'GET',
      url: `/users/${body.id}/publickey`,
      headers: { cookie },
    });
    expect(JSON.parse(res.body).publicKey).toEqual({ kty: 'EC', crv: 'P-256', x: X, y: Y });
  });
});

describe('channel glossary', () => {
  it('only a DM participant can read or change its glossary', async () => {
    const pat = await createTestUser(app, 'pat');
    const sam = await createTestUser(app, 'sam');
    const eve = await createTestUser(app, 'eve');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: pat.cookie },
      payload: { participantId: sam.body.id },
    });
    const dmId = JSON.parse(dm.body).id as string;
    const url = `/channels/${dmId}/glossary`;

    const outsiderPut = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie: eve.cookie },
      payload: { glossary: { a: 'b' } },
    });
    expect(outsiderPut.statusCode).toBe(403);
    const outsiderGet = await app.inject({ method: 'GET', url, headers: { cookie: eve.cookie } });
    expect(outsiderGet.statusCode).toBe(403);

    const put = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie: pat.cookie },
      payload: { glossary: { a: 'b' } },
    });
    expect(put.statusCode).toBe(200);
  });

  it('a non-member cannot change a server channel glossary', async () => {
    const owner = await createTestUser(app, 'owner');
    const eve = await createTestUser(app, 'eve');
    const s = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: owner.cookie },
      payload: { name: 'House' },
    });
    const serverId = JSON.parse(s.body).id as string;
    const ch = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: owner.cookie },
      payload: { name: 'general-2' },
    });
    const channelId = JSON.parse(ch.body).id as string;
    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie: eve.cookie },
      payload: { glossary: { a: 'b' } },
    });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/glossary`,
      headers: { cookie: owner.cookie },
      payload: { glossary: { a: 'b' } },
    });
    expect(ok.statusCode).toBe(200);
  });
});
