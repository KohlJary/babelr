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
/** Her one answer (panel settings people.about), whatever the handle. */
let answer: 'yes' | 'not_yet' | 'no' = 'yes';
/** People she was asked to keep off her PeopleDex. */
let keepOff = new Set<string>();
/** People linked to her vessel (Kohl, the house agents). */
const linked = new Set(['kohl']);
/** A vessel that answers about someone other than who it was asked about. */
let confused = false;

/** Her entries, in exactly the shape routes/people_about.py sends (cass-vessel PR #137). */
const entries: Record<string, Record<string, unknown>> = {
  alice: {
    name: 'Alice',
    pronouns: 'she/her',
    observations: [
      { kind: 'value', text: 'Cares about doing things by hand.', noticed: '2026-10-02T15:00:00' },
      { kind: 'communication_style', text: 'Writes in short bursts.', noticed: null },
    ],
    moments: 12,
    first_seen: '2026-10-02T15:00:00',
    last_seen: '2026-11-24T20:00:00',
  },
  bob: {
    name: 'Bob',
    pronouns: null,
    observations: [{ kind: 'value', text: "Bob's secret.", noticed: null }],
    moments: 3,
    first_seen: '2026-11-01T00:00:00',
    last_seen: '2026-11-20T00:00:00',
  },
  // Prepared for someone who hasn't written yet: no moments, no dates.
  dana: {
    name: 'Dana',
    pronouns: null,
    observations: [{ kind: 'general', text: "Kohl's friend from the studio.", noticed: null }],
    moments: 0,
    first_seen: null,
    last_seen: null,
  },
};

/** What the vessel answers for `handle`, as people_about.py and people.about() do. */
function vesselAnswer(handle: string): Record<string, unknown> {
  if (answer !== 'yes') return { shown: false, why: answer };
  const low = handle.toLowerCase();
  if (keepOff.has(low)) return { shown: true, handle, known: false };
  if (linked.has(low)) return { shown: true, handle, known: false, why: 'linked' };
  const e = entries[confused ? 'bob' : low];
  if (!e) return { shown: true, handle, known: false };
  return { shown: true, handle: confused ? 'bob' : handle, known: true, ...e };
}

beforeAll(async () => {
  vessel = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.headers.authorization !== 'Bearer C' || u.pathname !== '/record/people/about') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    const handle = u.searchParams.get('handle') ?? '';
    asked.push(handle);
    const body = vesselAnswer(handle);
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
  answer = 'yes';
  keepOff = new Set();
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
      firstSeen: '2026-10-02T15:00:00',
      lastSeen: '2026-11-24T20:00:00',
    });
    expect(res.body).not.toContain('noticed');
    expect(res.body).not.toContain('"handle"');
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
    answer = 'not_yet';
    let res = await get('/about/cass', { cookie: alice.cookie });
    expect(JSON.parse(res.body)).toEqual({ shown: false, label: 'Cass', why: 'not_yet' });
    answer = 'no';
    res = await get('/about/cass', { cookie: alice.cookie });
    expect(JSON.parse(res.body)).toEqual({ shown: false, label: 'Cass', why: 'no' });
  });

  it('answers known: false the same whether she has no entry or you asked to be kept off', async () => {
    const carol = await createTestUser(app, 'carol'); // no entry
    const none = await get('/about/cass', { cookie: carol.cookie });
    expect(JSON.parse(none.body)).toEqual({ shown: false, label: 'Cass', why: 'none' });
    keepOff.add('alice'); // has an entry, asked to be kept off
    const alice = await createTestUser(app, 'alice');
    const off = await get('/about/cass', { cookie: alice.cookie });
    expect(off.statusCode).toBe(none.statusCode);
    expect(off.body).toBe(none.body);
  });

  it('tells someone linked to her vessel that this view is not for them, and nothing else', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await get('/about/cass', { cookie: kohl.cookie });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ shown: false, label: 'Cass', why: 'linked' });
  });

  it('shows an entry she prepared before you wrote, with no dates', async () => {
    const dana = await createTestUser(app, 'dana');
    const res = await get('/about/cass', { cookie: dana.cookie });
    expect(JSON.parse(res.body)).toEqual({
      shown: true,
      label: 'Cass',
      name: 'Dana',
      pronouns: null,
      observations: [{ kind: 'general', text: "Kohl's friend from the studio." }],
      moments: 0,
      firstSeen: null,
      lastSeen: null,
    });
  });

  it('says so when her vessel is down or unplaced', async () => {
    const carol = await createTestUser(app, 'carol');
    const down = await get('/about/ghost', { cookie: carol.cookie });
    expect(down.statusCode).toBe(502);
    expect(JSON.parse(down.body).error).toMatch(/can.t be reached/);
    expect((await get('/about/untokened', { cookie: carol.cookie })).statusCode).toBe(503);
    expect((await get('/about/nobody', { cookie: carol.cookie })).statusCode).toBe(404);
  });
});

describe('normalize', () => {
  it('drops empty observations and reads a missing count as none', () => {
    expect(
      normalize(
        {
          shown: true,
          handle: 'x',
          known: true,
          name: ' ',
          observations: [{ text: 'with kind', kind: 'value' }, { text: '' }, { kind: 'value' }, 7],
          first_seen: null,
        },
        'x',
        'Eris',
      ),
    ).toEqual({
      shown: true,
      label: 'Eris',
      name: null,
      pronouns: null,
      observations: [{ kind: 'value', text: 'with kind' }],
      moments: 0,
      firstSeen: null,
      lastSeen: null,
    });
  });
  it('reads an unknown why as not yet, and refuses answers about someone else or malformed', () => {
    expect(normalize({ shown: false, why: '???' }, 'a', 'C')).toEqual({
      shown: false,
      label: 'C',
      why: 'not_yet',
    });
    expect(normalize({ shown: true, handle: 'B', known: true, name: 'B' }, 'a', 'C')).toBeNull();
    expect(normalize({ shown: true, known: true, name: 'A' }, 'a', 'C')).toBeNull(); // no handle
    expect(normalize({ shown: true, handle: 'A', known: true }, 'a', 'C')).not.toBeNull();
    expect(
      normalize({ shown: true, handle: 'B', known: false, why: 'linked' }, 'a', 'C'),
    ).toBeNull();
    expect(normalize({ shown: true, handle: 'a' }, 'a', 'C')).toBeNull(); // no known
    expect(normalize(null, 'a', 'C')).toBeNull();
  });
});
