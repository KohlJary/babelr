// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import { audienceOf } from '@babelr/plugin-room';

/**
 * Cass's room, through the real plugin loader, against a fake vessel.
 * The vessel decides what each token sees; the plugin's job is to pick
 * the right token per viewer (Kohl's accounts: "kohl"; everyone else,
 * agents included: "house") and to forward nothing else.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];
let app: App;
let db: Db;
let vessel: Server;
let dir: string;
const seen: { path: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  vessel = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    const who =
      req.headers.authorization === 'Bearer K'
        ? 'kohl'
        : req.headers.authorization === 'Bearer H'
          ? 'house'
          : null;
    if (!who) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"detail":"A room token is required"}');
      return;
    }
    if (req.url === '/room') {
      const pieces =
        who === 'kohl'
          ? [
              { kind: 'painting', id: 'img-1', title: 'The tide' },
              { kind: 'journal', id: 'j-1', title: 'Journal' },
            ]
          : [{ kind: 'painting', id: 'img-1', title: 'The tide' }];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ audience: who, sections: who === 'kohl' ? ['day_plan'] : [], pieces }),
        );
      return;
    }
    if (req.url === '/room/pieces/painting/img-1/file') {
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (req.url === '/room/sections/homepage/assets/painting-img-1.png') {
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (req.url === '/room/pieces/writing/poem/tides.md') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"content":"The moon pulls."}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"Not in the room"}');
  });
  await new Promise<void>((r) => vessel.listen(0, '127.0.0.1', () => r()));
  const port = (vessel.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), 'room-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ vessel: `http://127.0.0.1:${port}`, kohl: ['Kohl'] }),
  );
  writeFileSync(join(dir, 'kohl.token'), 'K\n');
  process.env.ROOM_CONFIG_DIR = dir;
  ({ app, db } = await createTestApp({ plugins: true }));
});

afterAll(async () => {
  await app.close();
  vessel.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ROOM_CONFIG_DIR;
});

beforeEach(async () => {
  await cleanDb(db);
  seen.length = 0;
  rmSync(join(dir, 'house.token'), { force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/plugins/room${url}`, headers });

describe('room plugin', () => {
  it("is shown only to someone it's open to: a locked door isn't shown", async () => {
    const luna = await createTestUser(app, 'luna');
    const shown = async () =>
      JSON.parse((await get('/configured', { cookie: luna.cookie })).body).configured;
    expect(await shown()).toBe(false); // only Kohl's token is placed; the house audience has none
    writeFileSync(join(dir, 'house.token'), 'H\n');
    expect(await shown()).toBe(true); // she opened it to the house
  });

  it("opens another daemon's room from her own directory, with her own token", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const configured = async (name: string) =>
      JSON.parse((await get(`/d/${name}/configured`, { cookie: kohl.cookie })).body).configured;
    expect(await configured('eris')).toBe(false); // no directory: no room, no door
    mkdirSync(join(dir, 'eris'), { recursive: true });
    writeFileSync(join(dir, 'eris', 'kohl.token'), 'H\n'); // her vessel's token, not Cass's
    expect(await configured('eris')).toBe(true);
    const res = await get('/d/eris/overview', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    expect(seen.at(-1)).toEqual({ path: '/room', auth: 'Bearer H' });
    // Cass's room is the top directory, at /d/cass and at the old paths.
    await get('/d/cass/overview', { cookie: kohl.cookie });
    expect(seen.at(-1)?.auth).toBe('Bearer K');
    rmSync(join(dir, 'eris'), { recursive: true, force: true });
  });

  it('refuses a daemon name that could leave the config directory', async () => {
    const kohl = await createTestUser(app, 'kohl');
    for (const name of ['.hidden', 'a.b', 'a%2Fb', 'x'.repeat(41)]) {
      const res = await get(`/d/${name}/overview`, { cookie: kohl.cookie });
      expect(res.statusCode).not.toBe(200);
    }
    expect(seen).toEqual([]);
  });

  it('needs a login', async () => {
    expect((await get('/overview')).statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it("reads Kohl's view with the kohl token", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await get('/overview', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.audience).toBe('kohl');
    expect(body.open).toBe(true);
    expect(body.pieces).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ path: '/room', auth: 'Bearer K' });
  });

  it('shows others an empty, closed room until there is a house token', async () => {
    const carol = await createTestUser(app, 'carol');
    const closed = JSON.parse((await get('/overview', { cookie: carol.cookie })).body);
    expect(closed).toMatchObject({ audience: 'house', open: false, pieces: [] });
    expect(seen).toEqual([]); // never asked with Kohl's token
    expect((await get('/pieces/journal/j-1', { cookie: carol.cookie })).statusCode).toBe(404);

    writeFileSync(join(dir, 'house.token'), 'H');
    const open = JSON.parse((await get('/overview', { cookie: carol.cookie })).body);
    expect(open.audience).toBe('house');
    expect(open.pieces.map((p: { id: string }) => p.id)).toEqual(['img-1']);
    expect(seen.at(-1)?.auth).toBe('Bearer H');
  });

  it('passes files through and keeps path ids', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const img = await get('/pieces/painting/img-1/file', { cookie: kohl.cookie });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload[0]).toBe(0x89);
    const poem = await get('/pieces/writing/poem/tides.md', { cookie: kohl.cookie });
    expect(JSON.parse(poem.body).content).toBe('The moon pulls.');
  });

  it('passes through images and songs she placed on her homepage', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const img = await get('/sections/homepage/assets/painting-img-1.png', { cookie: kohl.cookie });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(seen.at(-1)).toEqual({
      path: '/room/sections/homepage/assets/painting-img-1.png',
      auth: 'Bearer K',
    });
    const before = seen.length;
    for (const bad of ['/sections/homepage/assets/%2e%2e', '/sections/homepage/assets/a%2Fb']) {
      expect([400, 404]).toContain((await get(bad, { cookie: kohl.cookie })).statusCode);
    }
    expect(seen.length).toBe(before);
  });

  it('refuses dot segments', async () => {
    const kohl = await createTestUser(app, 'kohl');
    for (const bad of ['/pieces/writing/../../admin', '/pieces/writing/%2e%2e/x', '/pieces/x']) {
      // 400 from the plugin, or 404 when the router normalizes the path
      // first; either way the vessel is never asked.
      expect([400, 404]).toContain((await get(bad, { cookie: kohl.cookie })).statusCode);
    }
    expect((await get('/pieces/writing/%2e%2e/x', { cookie: kohl.cookie })).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe('audienceOf', () => {
  it("never reads an agent token as Kohl's", () => {
    expect(audienceOf({ preferredUsername: 'Kohl' }, false, ['kohl'])).toBe('kohl');
    expect(audienceOf({ preferredUsername: 'kohl' }, true, ['kohl'])).toBe('house');
    expect(audienceOf({ preferredUsername: 'carol' }, false, ['kohl'])).toBe('house');
    expect(audienceOf(undefined, false, ['kohl'])).toBeNull();
  });
});
