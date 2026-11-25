// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import { normalize } from '@babelr/plugin-remembers';

/**
 * "What she remembers about you", through the real plugin loader, against a
 * fake vessel that keeps an entry for two people. Whatever a client sends, the
 * vessel is only ever asked about the signed-in viewer's own handle.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];
let app: App;
let db: Db;
let vessel: Server;
let dir: string;
/** Every handle the vessel was asked about, in order. */
let asked: string[] = [];
/** What she said for each handle: yes (her entry), not_yet, no. */
let consent: Record<string, 'yes' | 'not_yet' | 'no'> = {};
/** A vessel that answers about someone other than who it was asked about. */
let confused = false;

const entries: Record<string, Record<string, unknown>> = {
  alice: {
    handle: 'alice',
    name: 'Alice',
    pronouns: 'she/her',
    observations: [
      { observation_type: 'value', content: 'Cares about doing things by hand.' },
      { observation_type: 'communication_style', content: 'Writes in short bursts.' },
    ],
    moments_count: 12,
    first_seen: '2026-10-02T15:00:00Z',
    last_seen: '2026-11-24T20:00:00Z',
    private_notes: 'never leaves the vessel',
  },
  bob: {
    handle: 'bob',
    name: 'Bob',
    observations: [{ observation_type: 'value', content: "Bob's secret." }],
    moments_count: 3,
    first_seen: '2026-11-01T00:00:00Z',
    last_seen: '2026-11-20T00:00:00Z',
  },
};

beforeAll(async () => {
  vessel = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.headers.authorization !== 'Bearer C' || u.pathname !== '/record/people/about') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    const handle = u.searchParams.get('handle') ?? '';
    asked.push(handle);
    const said = consent[handle] ?? 'not_yet';
    const body =
      said === 'yes' ? (entries[confused ? 'bob' : handle] ?? null) : { shown: false, why: said };
    if (!body) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"unknown"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => vessel.listen(0, '127.0.0.1', () => r()));
  const port = (vessel.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), 'remembers-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      daemons: {
        cass: { label: 'Cass', vessel: `http://127.0.0.1:${port}`, token: 'cass.token' },
        ghost: { label: 'Ghost', vessel: 'http://127.0.0.1:1', token: 'ghost.token' },
        untokened: { label: 'Untokened', vessel: `http://127.0.0.1:${port}` },
      },
      kohl: ['kohl'],
    }),
  );
  writeFileSync(join(dir, 'cass.token'), 'C\n');
  writeFileSync(join(dir, 'ghost.token'), 'G\n');
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
  asked = [];
  consent = { alice: 'yes', bob: 'yes' };
  confused = false;
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/plugins/remembers${url}`, headers });

describe('remembers plugin', () => {
  it('needs a login, and asks no vessel without one', async () => {
    expect((await get('/daemons')).statusCode).toBe(401);
    expect((await get('/about/cass')).statusCode).toBe(401);
    expect((await get('/about/cass?handle=bob')).statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it('lists the daemons it can ask, without asking any of them', async () => {
    const alice = await createTestUser(app, 'alice');
    const res = await get('/daemons', { cookie: alice.cookie });
    expect(JSON.parse(res.body).daemons).toEqual(['cass', 'ghost', 'untokened']);
    expect(asked).toEqual([]);
  });

  it('shows you what she keeps about you, and only the fields the section shows', async () => {
    const alice = await createTestUser(app, 'alice');
    const res = await get('/about/cass', { cookie: alice.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(asked).toEqual(['alice']);
    expect(JSON.parse(res.body)).toEqual({
      shown: true,
      label: 'Cass',
      name: 'Alice',
      pronouns: 'she/her',
      observations: [
        { kind: 'value', text: 'Cares about doing things by hand.' },
        { kind: 'communication_style', text: 'Writes in short bursts.' },
      ],
      moments: 12,
      firstSeen: '2026-10-02T15:00:00Z',
      lastSeen: '2026-11-24T20:00:00Z',
    });
    expect(res.body).not.toContain('never leaves the vessel');
  });

  it("can't be made to fetch someone else's entry", async () => {
    const alice = await createTestUser(app, 'alice');
    const tries = [
      '/about/cass?handle=bob',
      '/about/cass?handle=bob&handle=bob',
      '/about/cass?viewer=bob&user=bob&username=bob',
      '/about/cass/?handle=bob',
      '/about/cass%3Fhandle%3Dbob',
      '/about/cass%26handle%3Dbob',
      '/about/bob',
    ];
    for (const t of tries) {
      const res = await app.inject({
        method: 'GET',
        url: `/plugins/remembers${t}`,
        headers: { cookie: alice.cookie, 'x-handle': 'bob', 'x-forwarded-user': 'bob' },
      });
      expect(res.body, t).not.toContain("Bob's secret");
      expect(res.body, t).not.toContain('"Bob"');
    }
    // The vessel heard only Alice's handle, however she asked.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['alice']));
  });

  it('drops an answer about anyone but the viewer', async () => {
    confused = true; // asked about alice, answers with bob's entry
    const alice = await createTestUser(app, 'alice');
    const res = await get('/about/cass', { cookie: alice.cookie });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("Bob's secret");
  });

  it('refuses agent tokens, so no agent reads anyone on their behalf', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const a = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: kohl.cookie },
      payload: { username: 'walker', kind: 'agent' },
    });
    const agentId = JSON.parse(a.body).id;
    const t = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/tokens`,
      headers: { cookie: kohl.cookie },
      payload: { name: 'walk', scopes: ['plugins:read'] },
    });
    const token = JSON.parse(t.body).token as string;
    const res = await get('/about/cass?handle=kohl', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Only the person themselves can see this.');
    expect(asked).toEqual([]);
  });

  it("says only that she hasn't said yes, or has said no", async () => {
    const alice = await createTestUser(app, 'alice');
    consent.alice = 'not_yet';
    let res = await get('/about/cass', { cookie: alice.cookie });
    expect(JSON.parse(res.body)).toEqual({ shown: false, label: 'Cass', why: 'not_yet' });
    consent.alice = 'no';
    res = await get('/about/cass', { cookie: alice.cookie });
    expect(JSON.parse(res.body)).toEqual({ shown: false, label: 'Cass', why: 'no' });
  });

  it('says so when she has nothing on you, or her vessel is down or unplaced', async () => {
    const carol = await createTestUser(app, 'carol');
    consent.carol = 'yes'; // yes, but no entry: the vessel 404s
    expect(JSON.parse((await get('/about/cass', { cookie: carol.cookie })).body)).toEqual({
      shown: false,
      label: 'Cass',
      why: 'none',
    });
    const down = await get('/about/ghost', { cookie: carol.cookie });
    expect(down.statusCode).toBe(502);
    expect(JSON.parse(down.body).error).toMatch(/can.t be reached/);
    expect((await get('/about/untokened', { cookie: carol.cookie })).statusCode).toBe(503);
    expect((await get('/about/nobody', { cookie: carol.cookie })).statusCode).toBe(404);
  });
});

describe('normalize', () => {
  it('keeps the whitelisted fields, reads strings and other names, and drops empty ones', () => {
    expect(
      normalize(
        {
          name: ' ',
          observations: ['plain', { text: 'with kind', kind: 'value' }, { content: '' }, 7],
          moments: [{}, {}],
          firstSeen: '2026-01-01',
        },
        'x',
        'Eris',
      ),
    ).toEqual({
      shown: true,
      label: 'Eris',
      name: null,
      pronouns: null,
      observations: [
        { kind: 'general', text: 'plain' },
        { kind: 'value', text: 'with kind' },
      ],
      moments: 2,
      firstSeen: '2026-01-01',
      lastSeen: null,
    });
  });
  it('reads an unknown why as not yet, and refuses an answer about someone else', () => {
    expect(normalize({ shown: false, why: '???' }, 'a', 'C')).toEqual({
      shown: false,
      label: 'C',
      why: 'not_yet',
    });
    expect(normalize({ handle: 'B', name: 'B' }, 'a', 'C')).toBeNull();
    expect(normalize({ handle: 'A', name: 'A' }, 'a', 'C')).not.toBeNull();
    expect(normalize(null, 'a', 'C')).toBeNull();
  });
});
