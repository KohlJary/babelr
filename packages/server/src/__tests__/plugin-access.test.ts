// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from './helpers.ts';
import { createRemoteActor } from './federation/helpers.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { signRequest, createDigest } from '../federation/signatures.ts';
import { createSign } from 'node:crypto';

/**
 * Access checks on plugin routes, through the real plugin loader.
 * One test per finding of the 2026-10-23 audit, plus the member and
 * owner paths that must keep working:
 *
 *   - by-slug resolvers served polls, tasks and boards with no login;
 *   - no plugin route checked server membership (a non-member created
 *     a board in someone else's server and edited their task);
 *   - cross-Tower plugin embeds dialed /plugins/<kind>/by-slug, which
 *     no Tower mounts.
 *
 * Cast: alice creates the server (and so holds its Admin role), carol
 * and dan are plain members, bob is an outsider, zed is a federated
 * actor on another Tower.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];

let app: App;
let db: Db;

const c: Record<'alice' | 'bob' | 'carol' | 'dan', string> = {
  alice: '',
  bob: '',
  carol: '',
  dan: '',
};
let serverId: string;
let otherServerId: string;
let pollSlug: string;
let carolPollSlug: string;
let unscopedPollSlug: string;
let optionId: string;
let boardSlug: string;
let todoColumnId: string;
let doneColumnId: string;
let aliceTaskSlug: string;
let carolTaskSlug: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body, json: () => JSON.parse(res.body) };
}

async function taskTitle(slug: string): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT title FROM plugin_pm_work_items WHERE slug = ${slug}`,
  )) as unknown as { title: string }[];
  return rows[0]?.title;
}

beforeAll(async () => {
  ({ app, db } = await createTestApp({ plugins: true }));
  await cleanDb(db);
  await db.execute(
    sql`TRUNCATE plugin_polls_votes, plugin_polls_options, plugin_polls_polls, plugin_pm_work_items, plugin_pm_columns, plugin_pm_boards CASCADE`,
  );

  for (const name of Object.keys(c) as (keyof typeof c)[]) {
    c[name] = (await createTestUser(app, name)).cookie;
  }

  const server = await call('POST', '/servers', c.alice, { name: 'Alice House' });
  expect(server.status).toBe(201);
  serverId = server.json().id;
  // Servers are invite-only unless public; make this one open to join.
  await call('PUT', `/servers/${serverId}`, c.alice, { isPublic: true });
  const other = await call('POST', '/servers', c.bob, { name: 'Bob Shed' });
  otherServerId = other.json().id;
  for (const m of [c.carol, c.dan]) {
    expect((await call('POST', `/servers/${serverId}/join`, m)).status).toBeLessThan(300);
  }

  const poll = await call('POST', '/plugins/polls/polls', c.alice, {
    question: 'DRAFT confidential: which plan?',
    options: ['A', 'B'],
    serverId,
  });
  expect(poll.status).toBe(200);
  pollSlug = poll.json().slug;
  optionId = poll.json().options[0].id;
  carolPollSlug = (
    await call('POST', '/plugins/polls/polls', c.carol, {
      question: 'Lunch?',
      options: ['Yes', 'No'],
      serverId,
    })
  ).json().slug;
  unscopedPollSlug = (
    await call('POST', '/plugins/polls/polls', c.alice, { question: 'Tea?', options: ['Y', 'N'] })
  ).json().slug;

  const board = await call('POST', '/plugins/project-management/boards', c.alice, {
    serverId,
    name: 'Roadmap',
  });
  expect(board.status).toBe(200);
  boardSlug = board.json().slug;
  todoColumnId = board.json().columns[0].id;
  doneColumnId = board.json().columns[2].id;

  const t1 = await call(
    'POST',
    `/plugins/project-management/boards/${boardSlug}/work-items`,
    c.alice,
    { columnId: todoColumnId, title: 'DRAFT confidential task', description: 'secret' },
  );
  expect(t1.status).toBe(200);
  aliceTaskSlug = t1.json().slug;
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logged out', () => {
  it('cannot read polls, tasks or boards by slug', async () => {
    const urls = [
      `/plugins/polls/poll/by-slug/${pollSlug}`,
      `/plugins/polls/poll/by-slug/${unscopedPollSlug}`,
      `/plugins/project-management/task/by-slug/${aliceTaskSlug}`,
      `/plugins/project-management/board/by-slug/${boardSlug}`,
      `/plugins/polls/polls/${pollSlug}`,
      `/plugins/hello/hello/by-slug/world`,
    ];
    for (const url of urls) {
      const res = await call('GET', url);
      expect(res.status, url).toBe(401);
      expect(res.body).not.toContain('confidential');
    }
  });

  it('is refused on every other plugin route too (deny by default)', async () => {
    expect((await call('GET', `/plugins/project-management/boards/${boardSlug}`)).status).toBe(401);
    expect(
      (await call('POST', `/plugins/polls/polls/${pollSlug}/vote`, undefined, { optionId })).status,
    ).toBe(401);
  });

  it('can reach a route the manifest declares public', async () => {
    const res = await call('GET', '/plugins/hello/ping');
    expect(res.status).toBe(200);
    expect(res.json().pong).toBe(true);
  });

  it('gets 404, not 401, for a plugin path that does not exist', async () => {
    expect((await call('GET', '/plugins/polls/no-such-route')).status).toBe(404);
  });
});

describe('a non-member', () => {
  it('cannot create a board in a server they are not in', async () => {
    const res = await call('POST', '/plugins/project-management/boards', c.bob, {
      serverId,
      name: 'Squatter board',
    });
    expect(res.status).toBe(404);
    const rows = (await db.execute(
      sql`SELECT id FROM plugin_pm_boards WHERE name = 'Squatter board'`,
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it("cannot edit or delete a task in someone else's server", async () => {
    const edit = await call(
      'PATCH',
      `/plugins/project-management/work-items/${aliceTaskSlug}`,
      c.bob,
      {
        title: 'pwned',
      },
    );
    expect(edit.status).toBe(404);
    const move = await call(
      'PATCH',
      `/plugins/project-management/work-items/${aliceTaskSlug}`,
      c.bob,
      {
        columnId: doneColumnId,
      },
    );
    expect(move.status).toBe(404);
    expect(
      (await call('DELETE', `/plugins/project-management/work-items/${aliceTaskSlug}`, c.bob))
        .status,
    ).toBe(404);
    expect(await taskTitle(aliceTaskSlug)).toBe('DRAFT confidential task');
  });

  it('cannot read anything scoped to the server', async () => {
    const urls = [
      `/plugins/polls/poll/by-slug/${pollSlug}`,
      `/plugins/polls/polls/${pollSlug}`,
      `/plugins/polls/polls?serverId=${serverId}`,
      `/plugins/project-management/task/by-slug/${aliceTaskSlug}`,
      `/plugins/project-management/board/by-slug/${boardSlug}`,
      `/plugins/project-management/boards/${boardSlug}`,
      `/plugins/project-management/boards?serverId=${serverId}`,
      `/plugins/project-management/work-items/${aliceTaskSlug}`,
    ];
    for (const url of urls) {
      const res = await call('GET', url, c.bob);
      expect(res.status, url).toBe(404);
      expect(res.body).not.toContain('confidential');
    }
  });

  it('cannot write anything else scoped to the server', async () => {
    const writes: Array<[string, string, unknown]> = [
      [
        'POST',
        `/plugins/project-management/boards/${boardSlug}/work-items`,
        { columnId: todoColumnId, title: 'x' },
      ],
      [
        'POST',
        `/plugins/project-management/boards/${boardSlug}/reorder`,
        { assignments: [{ columnId: doneColumnId, itemIds: [aliceTaskSlug] }] },
      ],
      ['POST', `/plugins/polls/polls/${pollSlug}/vote`, { optionId }],
      ['POST', `/plugins/polls/polls/${pollSlug}/close`, {}],
      ['POST', '/plugins/polls/polls', { question: 'q', options: ['a', 'b'], serverId }],
    ];
    for (const [method, url, payload] of writes) {
      const res = await call(method as 'POST', url, c.bob, payload);
      expect(res.status, url).toBe(404);
    }
    const votes = (await db.execute(
      sql`SELECT 1 FROM plugin_polls_votes v JOIN plugin_polls_polls p ON p.id = v.poll_id WHERE p.slug = ${pollSlug}`,
    )) as unknown as unknown[];
    expect(votes).toHaveLength(0);
  });

  it('still sees unscoped polls and their own server', async () => {
    expect((await call('GET', `/plugins/polls/polls/${unscopedPollSlug}`, c.bob)).status).toBe(200);
    const own = await call('POST', '/plugins/project-management/boards', c.bob, {
      serverId: otherServerId,
      name: 'Shed board',
    });
    expect(own.status).toBe(200);
  });

  it('gets 404 for a malformed serverId, not a 500', async () => {
    const res = await call('POST', '/plugins/project-management/boards', c.bob, {
      serverId: 'not-a-uuid',
      name: 'x',
    });
    expect(res.status).toBe(404);
  });
});

describe('a member', () => {
  it('reads the server’s polls, boards and tasks, by route and by slug', async () => {
    for (const url of [
      `/plugins/polls/poll/by-slug/${pollSlug}`,
      `/plugins/polls/polls/${pollSlug}`,
      `/plugins/polls/polls?serverId=${serverId}`,
      `/plugins/project-management/task/by-slug/${aliceTaskSlug}`,
      `/plugins/project-management/board/by-slug/${boardSlug}`,
      `/plugins/project-management/boards/${boardSlug}`,
      `/plugins/project-management/boards?serverId=${serverId}`,
      `/plugins/project-management/work-items/${aliceTaskSlug}`,
    ]) {
      expect((await call('GET', url, c.carol)).status, url).toBe(200);
    }
  });

  it('creates work items, votes, and moves any card', async () => {
    const created = await call(
      'POST',
      `/plugins/project-management/boards/${boardSlug}/work-items`,
      c.carol,
      { columnId: todoColumnId, title: 'Carol task' },
    );
    expect(created.status).toBe(200);
    carolTaskSlug = created.json().slug;

    expect(
      (await call('POST', `/plugins/polls/polls/${pollSlug}/vote`, c.carol, { optionId })).status,
    ).toBe(200);

    const move = await call(
      'PATCH',
      `/plugins/project-management/work-items/${aliceTaskSlug}`,
      c.carol,
      { columnId: doneColumnId, position: 0 },
    );
    expect(move.status).toBe(200);
    expect(move.json().columnId).toBe(doneColumnId);

    const reorder = await call(
      'POST',
      `/plugins/project-management/boards/${boardSlug}/reorder`,
      c.carol,
      { assignments: [{ columnId: todoColumnId, itemIds: [aliceTaskSlug, carolTaskSlug] }] },
    );
    expect(reorder.status, reorder.body).toBe(204);
  });

  it('gets 400, not 500, for a malformed optionId', async () => {
    const res = await call('POST', `/plugins/polls/polls/${pollSlug}/vote`, c.carol, {
      optionId: 'nope',
    });
    expect(res.status).toBe(400);
  });
});

describe('live updates', () => {
  it("go to the server's local members only, never to every socket", async () => {
    const ids: Record<string, string> = {};
    for (const name of ['alice', 'bob', 'carol', 'dan']) {
      const [row] = await db.select().from(actors).where(eq(actors.preferredUsername, name));
      ids[name] = row.id;
    }
    wsSent.length = 0;
    const res = await call(
      'POST',
      `/plugins/project-management/boards/${boardSlug}/work-items`,
      c.dan,
      { columnId: todoColumnId, title: 'Dan task' },
    );
    expect(res.status).toBe(200);
    // broadcastPm is fire-and-forget; wait until all three are sent.
    await vi.waitFor(() =>
      expect(new Set(wsSent.map((w) => w.to))).toEqual(new Set([ids.alice, ids.carol, ids.dan])),
    );
    expect(wsSent).toHaveLength(3);

    wsSent.length = 0;
    await call('POST', `/plugins/polls/polls/${pollSlug}/vote`, c.dan, { optionId });
    expect(new Set(wsSent.map((w) => w.to))).toEqual(new Set([ids.alice, ids.carol, ids.dan]));
  });
});

describe('ownership', () => {
  it("stops a plain member editing, deleting or closing someone else's item", async () => {
    const edit = await call(
      'PATCH',
      `/plugins/project-management/work-items/${carolTaskSlug}`,
      c.dan,
      { title: 'dan was here' },
    );
    expect(edit.status).toBe(403);
    expect(await taskTitle(carolTaskSlug)).toBe('Carol task');
    expect(
      (await call('DELETE', `/plugins/project-management/work-items/${carolTaskSlug}`, c.dan))
        .status,
    ).toBe(403);
    expect((await call('POST', `/plugins/polls/polls/${pollSlug}/close`, c.dan, {})).status).toBe(
      403,
    );
  });

  it('lets the creator edit their own task and close their own poll', async () => {
    const edit = await call(
      'PATCH',
      `/plugins/project-management/work-items/${carolTaskSlug}`,
      c.carol,
      { title: 'Carol task, renamed' },
    );
    expect(edit.status).toBe(200);
    expect(await taskTitle(carolTaskSlug)).toBe('Carol task, renamed');
    const close = await call('POST', `/plugins/polls/polls/${carolPollSlug}/close`, c.carol, {});
    expect(close.status).toBe(200);
    expect(close.json().closedAt).not.toBeNull();
  });

  it('lets a server admin edit and delete a member’s task and close their poll', async () => {
    const reopen = await db.execute(
      sql`UPDATE plugin_polls_polls SET closed_at = NULL WHERE slug = ${carolPollSlug}`,
    );
    expect(reopen).toBeDefined();
    const edit = await call(
      'PATCH',
      `/plugins/project-management/work-items/${carolTaskSlug}`,
      c.alice,
      { priority: 'high' },
    );
    expect(edit.status).toBe(200);
    expect(
      (await call('POST', `/plugins/polls/polls/${carolPollSlug}/close`, c.alice, {})).status,
    ).toBe(200);
    expect(
      (await call('DELETE', `/plugins/project-management/work-items/${carolTaskSlug}`, c.alice))
        .status,
    ).toBe(204);
    expect(await taskTitle(carolTaskSlug)).toBeUndefined();
  });
});

describe('federated by-slug callers', () => {
  async function signedGet(path: string, signer: { uri: string; key: string }, date?: string) {
    const { headers } = signRequest(
      signer.key,
      `${signer.uri}#main-key`,
      'GET',
      `http://test.babelr.local${path}`,
    );
    if (date) headers.Date = date;
    return app.inject({ method: 'GET', url: path, headers });
  }

  it('serves a verified member, hides from a verified non-member, refuses a bad signature', async () => {
    const zed = await createRemoteActor(db, { username: 'zed', domain: 'remote.example' });
    const yan = await createRemoteActor(db, { username: 'yan', domain: 'remote.example' });
    const [server] = await db.select().from(actors).where(eq(actors.id, serverId)).limit(1);
    await db
      .insert(collectionItems)
      .values({ collectionUri: server.followersUri!, itemUri: zed.actor.uri });

    const path = `/plugins/project-management/board/by-slug/${boardSlug}`;
    const member = await signedGet(path, { uri: zed.actor.uri, key: zed.privateKeyPem });
    expect(member.statusCode).toBe(200);
    expect(JSON.parse(member.body).slug).toBe(boardSlug);

    const outsider = await signedGet(path, { uri: yan.actor.uri, key: yan.privateKeyPem });
    expect(outsider.statusCode).toBe(404);

    // zed's keyId, signed with yan's key: the signature doesn't verify.
    const forged = await signedGet(path, { uri: zed.actor.uri, key: yan.privateKeyPem });
    expect(forged.statusCode).toBe(401);

    // A captured request replayed long after its Date.
    const stale = await signedGet(
      path,
      { uri: zed.actor.uri, key: zed.privateKeyPem },
      new Date(Date.now() - 60 * 60 * 1000).toUTCString(),
    );
    expect(stale.statusCode).toBe(401);
  });

  it('refuses a signature that does not cover the Date', async () => {
    const [zed] = await db.select().from(actors).where(eq(actors.preferredUsername, 'zed'));
    const path = `/plugins/project-management/board/by-slug/${boardSlug}`;
    const digest = createDigest('');
    const headerList = '(request-target) host digest';
    const signingString = [
      `(request-target): get ${path}`,
      'host: test.babelr.local',
      `digest: ${digest}`,
    ].join('\n');
    const sig = createSign('sha256').update(signingString).sign(zed.privateKeyPem!, 'base64');
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: {
        host: 'test.babelr.local',
        date: new Date().toUTCString(),
        digest,
        signature: `keyId="${zed.uri}#main-key",algorithm="rsa-sha256",headers="${headerList}",signature="${sig}"`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not let a signature stand in for a session on ordinary plugin routes', async () => {
    const [zed] = await db.select().from(actors).where(eq(actors.preferredUsername, 'zed'));
    const priv = zed.privateKeyPem!;
    const path = `/plugins/project-management/boards/${boardSlug}`;
    const res = await signedGet(path, { uri: zed.uri, key: priv });
    expect(res.statusCode).toBe(401);
  });
});

describe('cross-Tower plugin embeds', () => {
  it("dial the owning plugin's by-slug route on the remote Tower", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ slug: 'abc', question: 'remote?' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const cases: Array<[string, string]> = [
      ['poll', '/plugins/polls/poll/by-slug/abc'],
      ['task', '/plugins/project-management/task/by-slug/abc'],
      ['board', '/plugins/project-management/board/by-slug/abc'],
    ];
    for (const [kind, path] of cases) {
      fetchSpy.mockClear();
      const res = await call(
        'GET',
        `/embeds/resolve?server=s&tower=remote.example&kind=${kind}&slug=abc`,
        c.carol,
      );
      expect(res.status, kind).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe(`http://remote.example${path}`);
    }
  });

  it('rejects a kind no plugin owns', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await call(
      'GET',
      '/embeds/resolve?server=s&tower=remote.example&kind=nope&slug=abc',
      c.carol,
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('public-votes polls', () => {
  it('show who voted for what on GET, to anyone who can see the poll', async () => {
    const created = await call('POST', '/plugins/polls/polls', c.alice, {
      question: 'Queue 0011',
      options: ['Approve', 'Hold', 'Veto'],
      serverId,
      publicVotes: true,
    });
    expect(created.status).toBe(200);
    expect(created.json().publicVotes).toBe(true);
    const slug = created.json().slug;
    const approve = created.json().options[0].id;

    wsSent.length = 0;
    expect(
      (await call('POST', `/plugins/polls/polls/${slug}/vote`, c.carol, { optionId: approve }))
        .status,
    ).toBe(200);
    // The live broadcast carries counts, never voters.
    expect(JSON.stringify(wsSent)).not.toContain('actorUri');

    const seen = await call('GET', `/plugins/polls/polls/${slug}`, c.dan);
    expect(seen.status).toBe(200);
    const votes = seen.json().votes;
    expect(votes).toHaveLength(1);
    expect(votes[0].optionId).toBe(approve);
    expect(votes[0].actorUri).toContain('carol');
  });

  it('stay private by default', async () => {
    await call('POST', `/plugins/polls/polls/${pollSlug}/vote`, c.carol, { optionId });
    const seen = await call('GET', `/plugins/polls/polls/${pollSlug}`, c.alice);
    expect(seen.json().publicVotes).toBe(false);
    expect(seen.json().votes).toBeUndefined();
  });

  it('reject a publicVotes that is not a boolean', async () => {
    const res = await call('POST', '/plugins/polls/polls', c.alice, {
      question: 'Q',
      options: ['A', 'B'],
      publicVotes: 'yes',
    });
    expect(res.status).toBe(400);
  });
});
