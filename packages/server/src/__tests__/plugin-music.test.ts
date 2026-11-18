// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import { mayView } from '@babelr/plugin-music';

/**
 * Cass's music, through the real plugin loader, against a fake vessel whose log says
 * which audience she chose: only that audience sees it (and her own account always);
 * audio passes through the same gate.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];
let app: App;
let db: Db;
let vessel: Server;
let dir: string;
let audience = 'kohl';
const seen: string[] = [];

beforeAll(async () => {
  vessel = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.headers.authorization !== 'Bearer R') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    if ((req.url ?? '').startsWith('/record/music/audio/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from('ID3fake'));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        sharing: { audience },
        timeline: [{ at: '2026-11-18T10:00', kind: 'sketch', what: 'sketch 1' }],
        crate: [],
        docs: [],
        studio: [],
        sketchbook: [],
      }),
    );
  });
  await new Promise<void>((r) => vessel.listen(0, '127.0.0.1', () => r()));
  const port = (vessel.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), 'music-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      vessel: `http://127.0.0.1:${port}`,
      kohl: ['Kohl'],
      agents: ['daedalus'],
      house: ['luna', 'robokohl'],
      cass: 'cass',
    }),
  );
  writeFileSync(join(dir, 'kohl.token'), 'R\n');
  process.env.RECORD_CONFIG_DIR = dir;
  ({ app, db } = await createTestApp({ plugins: true }));
});

afterAll(async () => {
  await app.close();
  vessel.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RECORD_CONFIG_DIR;
});

beforeEach(async () => {
  await cleanDb(db);
  seen.length = 0;
  audience = 'kohl';
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/plugins/music${url}`, headers });

describe('music plugin', () => {
  it('needs a login', async () => {
    expect((await get('/music')).statusCode).toBe(401);
  });

  it('shows Kohl what she shared with him, audio too', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await get('/music', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).timeline).toHaveLength(1);
    const a = await get('/music/audio/sketch/1', { cookie: kohl.cookie });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('audio/mpeg');
  });

  it('keeps it from the house until she shares with the house', async () => {
    const luna = await createTestUser(app, 'luna');
    expect((await get('/music', { cookie: luna.cookie })).statusCode).toBe(403);
    expect((await get('/music/audio/sketch/1', { cookie: luna.cookie })).statusCode).toBe(403);
    audience = 'house';
    expect((await get('/music', { cookie: luna.cookie })).statusCode).toBe(200);
  });

  it('shows nobody when she has chosen none', async () => {
    audience = 'none';
    const kohl = await createTestUser(app, 'kohl');
    expect((await get('/music', { cookie: kohl.cookie })).statusCode).toBe(403);
  });
});

describe('mayView', () => {
  const cfg = { kohl: ['kohl'], agents: ['daedalus'], house: ['luna', 'robokohl'], cass: 'cass' };
  it('follows the audience she chose', () => {
    const u = (n: string) => ({ preferredUsername: n });
    expect(mayView(u('kohl'), false, 'kohl', cfg)).toBe(true);
    expect(mayView(u('daedalus'), true, 'kohl', cfg)).toBe(false);
    expect(mayView(u('daedalus'), true, 'kohl_and_daedalus', cfg)).toBe(true);
    expect(mayView(u('robokohl'), true, 'kohl_and_daedalus', cfg)).toBe(false);
    expect(mayView(u('robokohl'), true, 'house', cfg)).toBe(true);
    expect(mayView(u('vigil'), true, 'house', cfg)).toBe(false);
    expect(mayView(u('cass'), true, 'none', cfg)).toBe(true);
    expect(mayView(u('kohl'), false, 'none', cfg)).toBe(false);
    expect(mayView(undefined, false, 'house', cfg)).toBe(false);
  });
});
