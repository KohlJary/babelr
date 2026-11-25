// SPDX-License-Identifier: MIT
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

async function scaffold() {
  const owner = await createTestUser(app, 'owner');
  const member = await createTestUser(app, 'member');
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: owner.cookie },
    payload: { name: 'Audit Server' },
  });
  const serverId = JSON.parse(serverRes.body).id as string;
  await app.inject({
    method: 'PUT',
    url: `/servers/${serverId}`,
    headers: { cookie: owner.cookie },
    payload: { isPublic: true },
  });
  await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/join`,
    headers: { cookie: member.cookie },
  });
  // Something to log
  await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/channels`,
    headers: { cookie: owner.cookie },
    payload: { name: 'logged' },
  });
  return { owner, member, serverId };
}

function getLog(cookie: string, serverId: string) {
  return app.inject({ method: 'GET', url: `/servers/${serverId}/audit-log`, headers: { cookie } });
}

describe('GET /servers/:serverId/audit-log', () => {
  it("lets the server's owner (Admin) read it", async () => {
    // FINDINGS #52: VIEW_AUDIT_LOG is in no default role, so the owner got 403.
    const { owner, serverId } = await scaffold();
    const res = await getLog(owner.cookie, serverId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('refuses a plain member', async () => {
    const { member, serverId } = await scaffold();
    expect((await getLog(member.cookie, serverId)).statusCode).toBe(403);
  });

  it('refuses a non-member', async () => {
    const { serverId } = await scaffold();
    const stranger = await createTestUser(app, 'stranger');
    expect((await getLog(stranger.cookie, serverId)).statusCode).toBe(403);
  });
});
