// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import { readPositions } from '../../db/schema/read-positions.ts';
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

async function serverChannel(cookie: string) {
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name: 'Read Server' },
  });
  const serverId = JSON.parse(serverRes.body).id;
  const channelsRes = await app.inject({
    method: 'GET',
    url: `/servers/${serverId}/channels`,
    headers: { cookie },
  });
  return { serverId, channelId: JSON.parse(channelsRes.body)[0].id as string };
}

function markRead(cookie: string, channelId: string) {
  return app.inject({ method: 'PUT', url: `/channels/${channelId}/read`, headers: { cookie } });
}

describe('PUT /channels/:channelId/read', () => {
  it('marks read, and marking again updates the same row', async () => {
    const { cookie, body: alice } = await createTestUser(app, 'alice');
    const { channelId } = await serverChannel(cookie);

    const first = await markRead(cookie, channelId);
    expect(first.statusCode).toBe(200);
    const [row1] = await db
      .select()
      .from(readPositions)
      .where(and(eq(readPositions.actorId, alice.id), eq(readPositions.channelId, channelId)));

    const second = await markRead(cookie, channelId);
    expect(second.statusCode).toBe(200);
    const rows = await db
      .select()
      .from(readPositions)
      .where(and(eq(readPositions.actorId, alice.id), eq(readPositions.channelId, channelId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(row1.id);
    expect(rows[0].lastReadAt.getTime()).toBeGreaterThanOrEqual(row1.lastReadAt.getTime());
  });

  it('does not 500 when the same channel is marked read concurrently', async () => {
    // FINDINGS #80: select-then-insert raced and hit the unique index.
    const { cookie, body: alice } = await createTestUser(app, 'alice');
    const { channelId } = await serverChannel(cookie);

    const results = await Promise.all(
      Array.from({ length: 25 }, () => markRead(cookie, channelId)),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(25).fill(200));

    const rows = await db
      .select()
      .from(readPositions)
      .where(and(eq(readPositions.actorId, alice.id), eq(readPositions.channelId, channelId)));
    expect(rows).toHaveLength(1);
  });

  it('refuses someone who cannot read the channel', async () => {
    const { cookie: aliceCookie } = await createTestUser(app, 'alice');
    const { cookie: bobCookie } = await createTestUser(app, 'bob');
    const { channelId } = await serverChannel(aliceCookie);

    const res = await markRead(bobCookie, channelId);
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown channel', async () => {
    const { cookie } = await createTestUser(app, 'alice');
    const res = await markRead(cookie, '00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});
