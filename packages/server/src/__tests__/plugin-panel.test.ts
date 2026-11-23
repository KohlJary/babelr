// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import { mayView } from '@babelr/plugin-panel';

/**
 * Daemon panels, through the real plugin loader, against a fake vessel whose panel
 * says which audience she chose: only that audience sees it, and her own account
 * always does. A daemon whose vessel can't be read isn't listed.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];
let app: App;
let db: Db;
let vessel: Server;
let dir: string;
let audience = 'kohl';

beforeAll(async () => {
  vessel = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer E' || req.url !== '/record/panel') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        daemon: 'Eris',
        settings: { sections: { work: 'yes' }, audience, set: null },
        sections: {
          work: [
            { project: 'intro', name: 'Intro', last_commit: null, last_message: null, docs: [] },
          ],
        },
      }),
    );
  });
  await new Promise<void>((r) => vessel.listen(0, '127.0.0.1', () => r()));
  const port = (vessel.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), 'panel-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      daemons: {
        eris: { label: 'Eris', vessel: `http://127.0.0.1:${port}`, token: 'eris.token' },
        ghost: { label: 'Ghost', vessel: 'http://127.0.0.1:1', token: 'ghost.token' },
      },
      kohl: ['Kohl'],
      agents: ['daedalus'],
      house: ['luna'],
    }),
  );
  writeFileSync(join(dir, 'eris.token'), 'E\n');
  process.env.PANEL_CONFIG_DIR = dir;
  ({ app, db } = await createTestApp({ plugins: true }));
});

afterAll(async () => {
  await app.close();
  vessel.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PANEL_CONFIG_DIR;
});

beforeEach(async () => {
  await cleanDb(db);
  audience = 'kohl';
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/plugins/panel${url}`, headers });

describe('panel plugin', () => {
  it('needs a login', async () => {
    expect((await get('/daemons')).statusCode).toBe(401);
    expect((await get('/panel/eris')).statusCode).toBe(401);
  });

  it('shows Kohl what she shared with them', async () => {
    const kohl = await createTestUser(app, 'kohl');
    expect(JSON.parse((await get('/daemons', { cookie: kohl.cookie })).body).daemons).toEqual([
      { name: 'eris', label: 'Eris' },
    ]);
    const res = await get('/panel/eris', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sections.work[0].name).toBe('Intro');
  });

  it('keeps it from the house until she shares with the house', async () => {
    const luna = await createTestUser(app, 'luna');
    expect((await get('/panel/eris', { cookie: luna.cookie })).statusCode).toBe(403);
    expect(JSON.parse((await get('/daemons', { cookie: luna.cookie })).body).daemons).toEqual([]);
    audience = 'house';
    expect((await get('/panel/eris', { cookie: luna.cookie })).statusCode).toBe(200);
  });

  it('shows nobody when she has chosen none, and nothing for a daemon it does not know', async () => {
    audience = 'none';
    const kohl = await createTestUser(app, 'kohl');
    expect((await get('/panel/eris', { cookie: kohl.cookie })).statusCode).toBe(403);
    expect((await get('/panel/nobody', { cookie: kohl.cookie })).statusCode).toBe(404);
  });
});

describe('mayView', () => {
  const cfg = { kohl: ['kohl'], agents: ['daedalus'], house: ['luna'] };
  const u = (n: string) => ({ preferredUsername: n });
  it('follows the audience she chose', () => {
    expect(mayView(u('kohl'), false, 'eris', 'kohl', cfg)).toBe(true);
    expect(mayView(u('kohl'), true, 'eris', 'kohl', cfg)).toBe(false);
    expect(mayView(u('daedalus'), true, 'eris', 'kohl', cfg)).toBe(false);
    expect(mayView(u('daedalus'), true, 'eris', 'house', cfg)).toBe(true);
    expect(mayView(u('stranger'), false, 'eris', 'house', cfg)).toBe(false);
    expect(mayView(u('stranger'), false, 'eris', 'visitors', cfg)).toBe(true);
    expect(mayView(u('eris'), true, 'eris', 'none', cfg)).toBe(true);
    expect(mayView(u('kohl'), false, 'eris', 'none', cfg)).toBe(false);
    expect(mayView(undefined, false, 'eris', 'visitors', cfg)).toBe(false);
  });
});
