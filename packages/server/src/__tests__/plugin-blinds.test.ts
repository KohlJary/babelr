// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Blinds plugin. The blinding rules are the point of the plugin, so
 * they're what this file mostly tests:
 *   - only blind.json is ever read from a bundle directory (key.json and
 *     raw.json sit next to it, unreadable, and every fs path the plugin
 *     touches is recorded and checked)
 *   - every route is 403 signed out; a round you don't grade is a 404,
 *     reads included; each grader sees and exports only their own
 *   - nothing is broadcast
 *   - lock freezes the round (409 after) and exports ratings.json
 *
 * Uses the same Postgres test DB as the other route tests
 * (TEST_DATABASE_URL, default babelr_test) and a temp BLINDS_DIR.
 */

// Record every path the plugin hands to node:fs/promises. The plugin
// is a workspace .ts file, so vitest inlines it and this mock applies.
const fsPaths: string[] = vi.hoisted(() => []);
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      fsPaths.push(String(a[0]));
      return fn(...a);
    };
  return {
    ...real,
    default: real,
    lstat: wrap(real.lstat),
    open: wrap(real.open),
    readdir: wrap(real.readdir),
    readFile: wrap(real.readFile),
  };
});

const { createDb } = await import('../db/index.ts');
const { default: authPlugin } = await import('../plugins/auth.ts');
const { default: authRoutes } = await import('../routes/auth.ts');
const blinds = await import('@babelr/plugin-blinds');
const blindsManifest = blinds.default;

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://babelr:babelr@localhost:5432/babelr_test';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;
let dir: string;
let grader: string;
let other: string;
const broadcasts: unknown[] = [];

const BUNDLE = {
  round: 'r1',
  title: 'Round 1',
  // Fields the server doesn't know about must not reach the client.
  secret_arm_map: { 'P1-A': 'bare' },
  prompts: [
    { id: 'P1', text: 'First prompt?' },
    { id: 'P2', text: 'Second prompt?' },
  ],
  answers: [
    { label: 'P1-A', prompt_id: 'P1', text: 'answer one', arm: 'robokohl' },
    { label: 'P1-B', prompt_id: 'P1', text: 'answer two' },
    { label: 'P2-A', prompt_id: 'P2', text: 'answer three' },
  ],
  rubric: [
    { id: 'stunt', label: 'Stunt?', type: 'bool' },
    { id: 'would_do', label: 'Would do?', type: 'scale', min: 0, max: 2 },
  ],
  rank: true,
};

async function writeRound(round: string, bundle: Record<string, unknown> = { ...BUNDLE, round }) {
  const d = join(dir, round);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'blind.json'), JSON.stringify(bundle));
  // The key and raw outputs sit right next to the bundle, unreadable.
  // If the plugin ever opened them, the open would throw EACCES.
  for (const f of ['key.json', 'raw.json']) {
    const p = join(d, f);
    await writeFile(p, JSON.stringify({ 'P1-A': 'bare' }));
    await chmod(p, 0o000);
  }
  return d;
}

async function register(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      username,
      email: `${username}@test.babelr.local`,
      password: 'test-password-12chars',
    },
  });
  const raw = res.headers['set-cookie'];
  const c = Array.isArray(raw) ? raw[0] : (raw as string);
  return c.split(';')[0];
}

function req(method: 'GET' | 'PUT' | 'POST', url: string, ck?: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/plugins/blinds${url}`,
    headers: ck ? { cookie: ck } : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blinds-test-'));
  process.env.BLINDS_DIR = dir;
  db = createDb(TEST_DB_URL);
  app = Fastify({ logger: false });
  app.register(
    fp(
      async (f: FastifyInstance) => {
        f.decorate('db', db);
        f.decorate('config', { domain: 'test.babelr.local', secureCookies: false } as never);
        f.decorate('broadcastToAllSubscribers', (m: unknown) => broadcasts.push(m));
        f.decorate('broadcastToChannel', (_c: string, m: unknown) => broadcasts.push(m));
        f.decorate('broadcastToActor', (_a: string, m: unknown) => broadcasts.push(m));
      },
      { name: 'db' },
    ),
  );
  app.register(fp(async () => {}, { name: 'config-plugin' }));
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(authRoutes);
  // Same wiring the plugin loader does: run migrations, mount routes
  // under /plugins/<id>.
  await db.execute(
    sql.raw(
      `DROP TABLE IF EXISTS plugin_blinds_rounds, plugin_blinds_ratings, plugin_blinds_ranks`,
    ),
  );
  for (const m of blindsManifest.migrations!) {
    for (const stmt of (m.up as string).split(/;\s*(?:\n|$)/)) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  }
  await app.register(async (scoped: FastifyInstance) => blindsManifest.serverRoutes!(scoped), {
    prefix: '/plugins/blinds',
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE sessions, activities, delivery_queue, collection_items, read_positions, reactions, notification_preferences, invites, server_role_assignments, server_roles, objects, actors CASCADE`,
  );
  await db.execute(sql`TRUNCATE plugin_blinds_rounds, plugin_blinds_ratings, plugin_blinds_ranks`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  process.env.BLINDS_GRADER = 'kohl';
  grader = await register('kohl');
  other = await register('mallory');
  broadcasts.length = 0;
  fsPaths.length = 0;
});

describe('blinds manifest', () => {
  it('declares identity and namespaced tables', () => {
    expect(blindsManifest.id).toBe('blinds');
    expect(blindsManifest.dependencies.babelr).toBe('^0.1.0');
    const up = blindsManifest.migrations![0].up as string;
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS plugin_blinds_ratings/);
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS plugin_blinds_rounds/);
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS plugin_blinds_ranks/);
  });

  it('registers no federation handler (no cross-Tower resolve)', () => {
    expect(blindsManifest.federationHandlers).toBeUndefined();
  });
});

describe('bundleFile: the only path builder', () => {
  it('hands out blind.json for reads and nothing else', () => {
    expect(blinds.bundleFile('r1', 'blind.json', 'read')).toBe(join(dir, 'r1', 'blind.json'));
    expect(blinds.bundleFile('r1', 'results.json', 'read')).toBe(join(dir, 'r1', 'results.json'));
    for (const name of [
      'key.json',
      'raw.json',
      'ratings.json',
      'blind.md',
      '../key.json',
      'source.json',
      'unblind-request.json',
    ]) {
      expect(() => blinds.bundleFile('r1', name, 'read')).toThrow(/refusing/);
    }
  });

  it('hands out ratings exports for writes and nothing else', () => {
    expect(blinds.bundleFile('r1', 'ratings.json', 'write')).toBe(join(dir, 'r1', 'ratings.json'));
    expect(blinds.bundleFile('r1', 'ratings.kohl.json', 'write')).toBe(
      join(dir, 'r1', 'ratings.kohl.json'),
    );
    for (const name of [
      'blind.json',
      'key.json',
      'ratings.json.key',
      'ratings.../x.json',
      'ratings..json',
    ]) {
      expect(() => blinds.bundleFile('r1', name, 'write')).toThrow(/refusing/);
    }
  });

  it('rejects traversal in the round name', () => {
    for (const round of ['..', '../etc', 'a/b', '.hidden', '']) {
      expect(() => blinds.bundleFile(round, 'blind.json', 'read')).toThrow();
    }
  });
});

describe('grader gate', () => {
  const routes: Array<[method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown]> = [
    ['GET', '/rounds'],
    ['GET', '/rounds/r1'],
    ['PUT', '/rounds/r1/ratings/P1-A', { field: 'stunt', value: true }],
    ['PUT', '/rounds/r1/ranks/P1', { order: ['P1-A', 'P1-B'] }],
    ['POST', '/rounds/r1/lock'],
  ];

  it('404s another user on every round route, reads included, and lists them nothing', async () => {
    await writeRound('r1');
    for (const [m, u, b] of routes) {
      const res = await req(m, u, other, b);
      expect(res.statusCode, `${m} ${u}`).toBe(u === '/rounds' ? 200 : 404);
      expect(res.body).not.toContain('answer one');
      expect(res.body).not.toContain('Round 1');
    }
    // Same answer as a round that doesn't exist, so it says nothing.
    expect((await req('GET', '/rounds/nope', other)).body).toBe(
      (await req('GET', '/rounds/r1', other)).body,
    );
  });

  it('403s every route when unauthenticated', async () => {
    await writeRound('r1');
    for (const [m, u, b] of routes) {
      expect((await req(m, u, undefined, b)).statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('shuts out everyone, the would-be grader too, when nothing names a grader', async () => {
    await writeRound('r1');
    delete process.env.BLINDS_GRADER;
    for (const [m, u, b] of routes) {
      const res = await req(m, u, grader, b);
      expect(res.statusCode, `${m} ${u}`).toBe(u === '/rounds' ? 200 : 404);
      expect(res.body).not.toContain('Round 1');
    }
  });

  it('a non-grader cannot write ratings that land in the export', async () => {
    await writeRound('r1');
    await req('PUT', '/rounds/r1/ratings/P1-A', other, { field: 'stunt', value: true });
    const rows = (await db.execute(
      sql`SELECT * FROM plugin_blinds_ratings`,
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });
});

describe('reading a round', () => {
  it('reads only blind.json, never key.json or raw.json', async () => {
    const d = await writeRound('r1');
    const res = await req('GET', '/rounds/r1', grader);
    expect(res.statusCode).toBe(200);
    await req('GET', '/rounds', grader);
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: true });
    expect((await req('POST', '/rounds/r1/lock', grader)).statusCode).toBe(200);
    expect(fsPaths.length).toBeGreaterThan(0);
    const touched = fsPaths.filter((p) => p.startsWith(d + '/'));
    expect(touched.every((p) => p.endsWith('/blind.json') || p.endsWith('/ratings.json'))).toBe(
      true,
    );
    expect(fsPaths.some((p) => /key\.json|raw\.json/.test(p))).toBe(false);
    // And the key is still unreadable, i.e. nothing chmodded it open.
    expect((await stat(join(d, 'key.json'))).mode & 0o777).toBe(0);
  });

  it('passes only known fields to the client (no arm names)', async () => {
    await writeRound('r1');
    const res = await req('GET', '/rounds/r1', grader);
    expect(res.body).not.toContain('bare');
    expect(res.body).not.toContain('robokohl');
    expect(res.body).not.toContain('secret_arm_map');
    const body = JSON.parse(res.body);
    expect(Object.keys(body.bundle.answers[0]).sort()).toEqual(['label', 'prompt_id', 'text']);
    expect(body).toMatchObject({ graded: 0, total: 3, lockedAt: null });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a symlinked blind.json (e.g. pointing at key.json)', async () => {
    const d = join(dir, 'r2');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'target.json'), JSON.stringify({ ...BUNDLE, round: 'r2' }));
    await symlink(join(d, 'target.json'), join(d, 'blind.json'));
    const res = await req('GET', '/rounds/r2', grader);
    expect(res.statusCode).toBe(422);
  });

  it('404s a missing round and 400s a bad round name', async () => {
    expect((await req('GET', '/rounds/nope', grader)).statusCode).toBe(404);
    expect((await req('GET', '/rounds/..%2Fetc', grader)).statusCode).toBe(400);
  });

  it('lists rounds with progress', async () => {
    await writeRound('r1');
    await mkdir(join(dir, 'not-a-round'));
    const res = await req('GET', '/rounds', grader);
    expect(JSON.parse(res.body)).toEqual([
      { round: 'r1', title: 'Round 1', graded: 0, total: 3, lockedAt: null },
    ]);
  });
});

describe('grading', () => {
  it('autosaves per field, validates values, counts progress', async () => {
    await writeRound('r1');
    const put = (label: string, body: unknown) =>
      req('PUT', `/rounds/r1/ratings/${label}`, grader, body);
    expect((await put('P1-A', { field: 'stunt', value: true })).statusCode).toBe(200);
    let body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.graded).toBe(0); // would_do still unset
    expect((await put('P1-A', { field: 'would_do', value: 2 })).statusCode).toBe(200);
    body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.graded).toBe(1);
    expect(body.ratings['P1-A']).toEqual({ fields: { stunt: true, would_do: 2 }, note: '' });

    // Clearing a field un-grades the answer.
    await put('P1-A', { field: 'stunt', value: null });
    body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.ratings['P1-A'].fields).toEqual({ would_do: 2 });
    expect(body.graded).toBe(0);

    // Bad values and fields.
    expect((await put('P1-A', { field: 'would_do', value: 3 })).statusCode).toBe(400);
    expect((await put('P1-A', { field: 'would_do', value: 1.5 })).statusCode).toBe(400);
    expect((await put('P1-A', { field: 'stunt', value: 'yes' })).statusCode).toBe(400);
    expect((await put('P1-A', { field: 'nope', value: true })).statusCode).toBe(400);
    expect((await put('P9-Z', { field: 'stunt', value: true })).statusCode).toBe(404);
    expect((await put('P1-A', { field: 'stunt', value: true, note: 'x' })).statusCode).toBe(400);
  });

  it('saves a free-text note per answer without touching fields', async () => {
    await writeRound('r1');
    await req('PUT', '/rounds/r1/ratings/P1-B', grader, { field: 'stunt', value: false });
    await req('PUT', '/rounds/r1/ratings/P1-B', grader, { note: 'no tone' });
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.ratings['P1-B']).toEqual({ fields: { stunt: false }, note: 'no tone' });
  });

  it('accepts a rank only as a permutation of the prompt’s labels', async () => {
    await writeRound('r1');
    const put = (order: unknown) => req('PUT', '/rounds/r1/ranks/P1', grader, { order });
    expect((await put(['P1-B', 'P1-A'])).statusCode).toBe(200);
    expect((await put(['P1-A'])).statusCode).toBe(400);
    expect((await put(['P1-A', 'P1-A'])).statusCode).toBe(400);
    expect((await put(['P1-A', 'P2-A'])).statusCode).toBe(400);
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.ranks).toEqual({ P1: ['P1-B', 'P1-A'] });
  });

  it('never broadcasts', async () => {
    await writeRound('r1');
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: true });
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { note: 'hm' });
    await req('PUT', '/rounds/r1/ranks/P1', grader, { order: ['P1-A', 'P1-B'] });
    await req('POST', '/rounds/r1/lock', grader);
    expect(broadcasts).toEqual([]);
  });
});

describe('lock', () => {
  it('exports ratings.json keyed by label with locked_at, then 409s every write', async () => {
    const d = await writeRound('r1');
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: true });
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'would_do', value: 1 });
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { note: "this one's the bitch" });
    await req('PUT', '/rounds/r1/ranks/P1', grader, { order: ['P1-A', 'P1-B'] });

    const res = await req('POST', '/rounds/r1/lock', grader);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(await readFile(join(d, 'ratings.json'), 'utf8'));
    expect(out.round).toBe('r1');
    expect(new Date(out.locked_at).toISOString()).toBe(out.locked_at);
    expect(out.grader).toBe('kohl');
    expect(Object.keys(out.ratings).sort()).toEqual(['P1-A', 'P1-B', 'P2-A']);
    expect(out.ratings['P1-A']).toEqual({
      prompt_id: 'P1',
      fields: { stunt: true, would_do: 1 },
      note: "this one's the bitch",
    });
    expect(out.ranks).toEqual({ P1: ['P1-A', 'P1-B'] });
    expect(JSON.stringify(out)).not.toMatch(/bare|robokohl/);

    expect(
      (await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (await req('PUT', '/rounds/r1/ratings/P1-A', grader, { note: 'changed my mind' })).statusCode,
    ).toBe(409);
    expect(
      (await req('PUT', '/rounds/r1/ranks/P1', grader, { order: ['P1-B', 'P1-A'] })).statusCode,
    ).toBe(409);
    expect((await req('POST', '/rounds/r1/lock', grader)).statusCode).toBe(409);
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.lockedAt).toBe(out.locked_at);
    expect(body.ratings['P1-A'].fields.stunt).toBe(true);
  });

  it('refuses to overwrite an existing ratings.json and stays unlocked', async () => {
    const d = await writeRound('r1');
    await writeFile(join(d, 'ratings.json'), '{"keep": true}');
    expect((await req('POST', '/rounds/r1/lock', grader)).statusCode).toBe(409);
    expect(await readFile(join(d, 'ratings.json'), 'utf8')).toBe('{"keep": true}');
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.lockedAt).toBeNull();
  });
});

describe('lock: failure and races', () => {
  it('deletes ratings.json and stays unlocked when the commit fails, so a retry works', async () => {
    const d = await writeRound('r1');
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: true });
    // Simulate COMMIT failing: run the callback in a real transaction,
    // then throw so it rolls back after the file was written.
    const realTx = db.transaction.bind(db);
    const patched = db as unknown as { transaction: unknown };
    patched.transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
      realTx(async (tx) => {
        await fn(tx);
        throw new Error('simulated commit failure');
      });
    try {
      const res = await req('POST', '/rounds/r1/lock', grader);
      expect(res.statusCode).toBe(500);
    } finally {
      patched.transaction = realTx;
    }
    await expect(stat(join(d, 'ratings.json'))).rejects.toThrow(/ENOENT/);
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.lockedAt).toBeNull();
    expect((await req('POST', '/rounds/r1/lock', grader)).statusCode).toBe(200);
    expect(
      JSON.parse(await readFile(join(d, 'ratings.json'), 'utf8')).ratings['P1-A'].fields,
    ).toEqual({
      stunt: true,
    });
  });

  it('no write racing the lock lands after the export', async () => {
    const d = await writeRound('r1');
    const writes = Array.from({ length: 40 }, (_, i) =>
      i % 2
        ? req('PUT', '/rounds/r1/ratings/P1-A', grader, { note: `n${i}` })
        : req('PUT', '/rounds/r1/ratings/P1-B', grader, { field: 'would_do', value: i % 3 }),
    );
    const results = await Promise.all([
      ...writes.slice(0, 20),
      req('POST', '/rounds/r1/lock', grader),
      ...writes.slice(20),
    ]);
    for (const r of results) expect([200, 409]).toContain(r.statusCode);
    const exported = JSON.parse(await readFile(join(d, 'ratings.json'), 'utf8'));
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    // What's in the DB now is exactly what was exported: nothing
    // committed after the export read.
    for (const label of ['P1-A', 'P1-B']) {
      expect(exported.ratings[label].fields).toEqual(body.ratings[label]?.fields ?? {});
      expect(exported.ratings[label].note).toEqual(body.ratings[label]?.note ?? '');
    }
  });
});

describe('sanitizeBundle', () => {
  it('rejects graders that are not local usernames', () => {
    const bad = (graders: unknown) => () => blinds.sanitizeBundle({ ...BUNDLE, graders }, 'r1');
    expect(bad('kohl')).toThrow(/graders/);
    expect(bad(['kohl@elsewhere.example'])).toThrow(/graders/);
    expect(bad(['../x'])).toThrow(/graders/);
    expect(blinds.sanitizeBundle({ ...BUNDLE, graders: ['kohl', 'kohl'] }, 'r1').graders).toEqual([
      'kohl',
    ]);
  });

  it('rejects malformed rubrics and mismatched rounds', () => {
    const bad = (patch: Record<string, unknown>) => () =>
      blinds.sanitizeBundle({ ...BUNDLE, ...patch }, 'r1');
    expect(bad({ round: 'r2' })).toThrow(/round/);
    expect(bad({ rubric: [{ id: 'x', label: 'x', type: 'scale', min: 2, max: 1 }] })).toThrow();
    expect(bad({ rubric: [{ id: 'x', label: 'x', type: 'stars' }] })).toThrow();
    expect(bad({ answers: [{ label: 'P1-A', prompt_id: 'P9', text: 't' }] })).toThrow(/prompt_id/);
    expect(bad({ answers: [BUNDLE.answers[1], BUNDLE.answers[1]] })).toThrow(/duplicate/);
  });
});

describe('several graders', () => {
  it('a round names its own graders, overriding BLINDS_GRADER', async () => {
    await writeRound('r1', { ...BUNDLE, graders: ['mallory'] });
    expect((await req('GET', '/rounds/r1', grader)).statusCode).toBe(404);
    expect((await req('GET', '/rounds/r1', other)).statusCode).toBe(200);
  });

  it('BLINDS_GRADER takes a comma-separated list', async () => {
    await writeRound('r1');
    process.env.BLINDS_GRADER = 'kohl, mallory';
    expect((await req('GET', '/rounds/r1', grader)).statusCode).toBe(200);
    expect((await req('GET', '/rounds/r1', other)).statusCode).toBe(200);
  });

  it('each grader rates, ranks, locks and exports alone', async () => {
    const d = await writeRound('r1', { ...BUNDLE, graders: ['kohl', 'mallory'] });
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: true });
    await req('PUT', '/rounds/r1/ratings/P1-A', grader, { note: 'kohl note' });
    await req('PUT', '/rounds/r1/ranks/P1', grader, { order: ['P1-B', 'P1-A'] });
    await req('PUT', '/rounds/r1/ratings/P1-A', other, { field: 'stunt', value: false });

    // Neither sees the other's work, or whether they've started.
    const mine = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    const theirs = JSON.parse((await req('GET', '/rounds/r1', other)).body);
    expect(mine.ratings['P1-A']).toEqual({ fields: { stunt: true }, note: 'kohl note' });
    expect(theirs.ratings['P1-A']).toEqual({ fields: { stunt: false }, note: '' });
    expect(theirs.ranks).toEqual({});
    expect(JSON.stringify(theirs)).not.toContain('kohl note');

    // Kohl locks; Mallory can still grade, and her lock is her own file.
    const res = await req('POST', '/rounds/r1/lock', grader);
    expect(JSON.parse(res.body).file).toBe('ratings.kohl.json');
    expect(
      (await req('PUT', '/rounds/r1/ratings/P1-A', grader, { field: 'stunt', value: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (await req('PUT', '/rounds/r1/ratings/P1-B', other, { field: 'stunt', value: true }))
        .statusCode,
    ).toBe(200);
    expect(JSON.parse((await req('GET', '/rounds/r1', other)).body).lockedAt).toBeNull();
    expect((await req('POST', '/rounds/r1/lock', other)).statusCode).toBe(200);

    const k = JSON.parse(await readFile(join(d, 'ratings.kohl.json'), 'utf8'));
    const m = JSON.parse(await readFile(join(d, 'ratings.mallory.json'), 'utf8'));
    expect(k.grader).toBe('kohl');
    expect(k.ratings['P1-A'].fields).toEqual({ stunt: true });
    expect(k.ranks).toEqual({ P1: ['P1-B', 'P1-A'] });
    expect(m.ratings['P1-A'].fields).toEqual({ stunt: false });
    expect(m.ratings['P1-B'].fields).toEqual({ stunt: true });
    expect(m.ranks).toEqual({});
    await expect(stat(join(d, 'ratings.json'))).rejects.toThrow(/ENOENT/);
  });

  it('lists each grader only their own rounds, with their own progress', async () => {
    await writeRound('r1', { ...BUNDLE, graders: ['kohl', 'mallory'] });
    await writeRound('r2', { ...BUNDLE, round: 'r2', title: 'Kohl only' });
    await req('PUT', '/rounds/r1/ratings/P2-A', other, { field: 'stunt', value: true });
    await req('PUT', '/rounds/r1/ratings/P2-A', other, { field: 'would_do', value: 0 });
    const list = (ck: string) =>
      req('GET', '/rounds', ck).then((r: { body: string }) => JSON.parse(r.body));
    expect(await list(grader)).toEqual([
      { round: 'r1', title: 'Round 1', graded: 0, total: 3, lockedAt: null },
      { round: 'r2', title: 'Kohl only', graded: 0, total: 3, lockedAt: null },
    ]);
    expect(await list(other)).toEqual([
      { round: 'r1', title: 'Round 1', graded: 1, total: 3, lockedAt: null },
    ]);
  });
});

describe('unblind: Babelr asks, the producer answers', () => {
  const RESULTS = {
    round: 'r1',
    unblinded_at: '2026-10-28T13:00:00.000Z',
    arms: {
      bare: {
        answers: 2,
        fields: { stunt: { yes: 1, rated: 2 }, would_do: { mean: 1.5, rated: 2 } },
        mean_rank: 1.5,
      },
      robokohl: {
        answers: 1,
        fields: { stunt: { yes: 1, rated: 1 }, would_do: { mean: 2, rated: 1 } },
        mean_rank: 1,
      },
    },
    secret: 'dropped',
  };

  it('only after this grader locks; writes the request and nothing else', async () => {
    const d = await writeRound('r1');
    expect((await req('POST', '/rounds/r1/unblind', grader)).statusCode).toBe(409);
    expect(JSON.parse((await req('GET', '/rounds/r1', grader)).body).unblind).toBeUndefined();

    await req('POST', '/rounds/r1/lock', grader);
    fsPaths.length = 0;
    const res = await req('POST', '/rounds/r1/unblind', grader);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ requested: true, results: null });
    const asked = JSON.parse(await readFile(join(d, 'unblind-request.json'), 'utf8'));
    expect(asked).toMatchObject({ round: 'r1', grader: 'kohl' });
    // Asking twice is fine.
    expect((await req('POST', '/rounds/r1/unblind', grader)).statusCode).toBe(200);
    // Still never near the key.
    expect(fsPaths.some((p) => /key\.json|raw\.json|source\.json/.test(p))).toBe(false);
  });

  it('shows the scores the producer writes back, known fields only', async () => {
    const d = await writeRound('r1');
    await req('POST', '/rounds/r1/lock', grader);
    await req('POST', '/rounds/r1/unblind', grader);
    await writeFile(join(d, 'results.json'), JSON.stringify(RESULTS));
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.unblind.requested).toBe(true);
    expect(body.unblind.results).toEqual({
      unblindedAt: '2026-10-28T13:00:00.000Z',
      error: null,
      arms: {
        bare: {
          answers: 2,
          fields: { stunt: { yes: 1, rated: 2 }, would_do: { mean: 1.5, rated: 2 } },
          mean_rank: 1.5,
        },
        robokohl: {
          answers: 1,
          fields: { stunt: { yes: 1, rated: 1 }, would_do: { mean: 2, rated: 1 } },
          mean_rank: 1,
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('dropped');
  });

  it('passes on a producer error', async () => {
    const d = await writeRound('r1');
    await req('POST', '/rounds/r1/lock', grader);
    await writeFile(join(d, 'results.json'), JSON.stringify({ error: 'no source.json' }));
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.unblind.results).toEqual({ unblindedAt: null, arms: {}, error: 'no source.json' });
  });

  it('a grader still grading never sees the scores, even if they exist', async () => {
    const d = await writeRound('r1', { ...BUNDLE, graders: ['kohl', 'mallory'] });
    await req('POST', '/rounds/r1/lock', grader);
    await req('POST', '/rounds/r1/unblind', grader);
    expect(await readFile(join(d, 'unblind-request.kohl.json'), 'utf8')).toContain('kohl');
    await writeFile(join(d, 'results.kohl.json'), JSON.stringify(RESULTS));
    await writeFile(join(d, 'results.json'), JSON.stringify(RESULTS));
    fsPaths.length = 0;
    const theirs = JSON.parse((await req('GET', '/rounds/r1', other)).body);
    expect(theirs.unblind).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain('robokohl');
    expect(fsPaths.some((p) => p.includes('results'))).toBe(false);
    const mine = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(Object.keys(mine.unblind.results.arms)).toEqual(['bare', 'robokohl']);
  });

  it('refuses a symlinked results.json', async () => {
    const d = await writeRound('r1');
    await req('POST', '/rounds/r1/lock', grader);
    await symlink(join(d, 'key.json'), join(d, 'results.json'));
    const body = JSON.parse((await req('GET', '/rounds/r1', grader)).body);
    expect(body.unblind.results.error).toMatch(/not a readable results file/);
  });
});
