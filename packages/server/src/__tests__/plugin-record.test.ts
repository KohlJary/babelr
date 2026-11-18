// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import { daysOf, mayRead } from '@babelr/plugin-record';

/**
 * Cass's record, through the real plugin loader, against a fake vessel:
 * Kohl's accounts read it with the record token; agents only when Kohl named
 * them; nobody else, and the vessel is never asked for them.
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
    if (req.headers.authorization !== 'Bearer R') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    if ((req.url ?? '').startsWith('/record/review.md')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('# Daily review\n');
      return;
    }
    if ((req.url ?? '').startsWith('/record.md')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('# Cass: the record\n');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ days: 30, entries: [{ at: '2026-11-18T04:20', who: 'cass' }] }));
  });
  await new Promise<void>((r) => vessel.listen(0, '127.0.0.1', () => r()));
  const port = (vessel.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), 'record-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ vessel: `http://127.0.0.1:${port}`, kohl: ['Kohl'], agents: ['daedalus'] }),
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
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/plugins/record${url}`, headers });

describe('record plugin', () => {
  it('needs a login', async () => {
    expect((await get('/record')).statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it('reads Kohl the record with the record token', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await get('/record?days=7', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).entries).toHaveLength(1);
    expect(seen.at(-1)).toEqual({ path: '/record?days=7', auth: 'Bearer R' });
    const md = await get('/record.md?days=bogus', { cookie: kohl.cookie });
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain('cass-record-30d.md');
    expect(md.body.startsWith('# Cass: the record')).toBe(true);
  });

  it('shows Kohl the daily review in place', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await get('/review.md?hours=12', { cookie: kohl.cookie });
    expect(res.body.startsWith('# Daily review')).toBe(true);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(seen.at(-1)).toEqual({ path: '/record/review.md?hours=12', auth: 'Bearer R' });
  });

  it('is not shown to anyone else, and the vessel is never asked', async () => {
    const carol = await createTestUser(app, 'carol');
    expect((await get('/record', { cookie: carol.cookie })).statusCode).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe('mayRead', () => {
  it('lets Kohl in as himself, and agents only by name through their tokens', () => {
    expect(mayRead({ preferredUsername: 'Kohl' }, false, ['kohl'], ['daedalus'])).toBe(true);
    expect(mayRead({ preferredUsername: 'kohl' }, true, ['kohl'], ['daedalus'])).toBe(false);
    expect(mayRead({ preferredUsername: 'daedalus' }, true, ['kohl'], ['daedalus'])).toBe(true);
    expect(mayRead({ preferredUsername: 'robokohl' }, true, ['kohl'], ['daedalus'])).toBe(false);
    expect(mayRead({ preferredUsername: 'daedalus' }, false, ['kohl'], ['daedalus'])).toBe(false);
    expect(mayRead(undefined, false, ['kohl'], ['daedalus'])).toBe(false);
  });

  it('keeps the range sane', () => {
    expect(daysOf('7')).toBe(7);
    expect(daysOf('0')).toBe(30);
    expect(daysOf('x')).toBe(30);
    expect(daysOf(undefined)).toBe(30);
  });
});
