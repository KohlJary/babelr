// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from './helpers.ts';

/**
 * Plans plugin, through the real plugin loader. Kohl owns the server
 * (and so approves); carol is a member; cass is an agent in the server;
 * bob is an outsider.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createTestApp>>['db'];
let app: App;
let db: Db;

beforeAll(async () => {
  ({ app, db } = await createTestApp({ plugins: true }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
  await db.execute(sql`TRUNCATE plugin_plans_plans CASCADE`);
  wsSent.length = 0;
});

type Who = { cookie?: string; token?: string };

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  who: Who,
  payload?: unknown,
  surface?: string,
) {
  const headers: Record<string, string> = who.token
    ? { authorization: `Bearer ${who.token}` }
    : { cookie: who.cookie ?? '' };
  if (surface) headers['x-plans-surface'] = surface;
  const res = await app.inject({
    method,
    url: `/plugins/plans${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, json: () => JSON.parse(res.body), body: res.body };
}

async function house() {
  const kohl = await createTestUser(app, 'kohl');
  const carol = await createTestUser(app, 'carol');
  const bob = await createTestUser(app, 'bob');
  const s = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: kohl.cookie },
    payload: { name: 'House' },
  });
  const serverId = JSON.parse(s.body).id as string;
  // Invite-only unless public: open it so carol can join.
  await app.inject({
    method: 'PUT',
    url: `/servers/${serverId}`,
    headers: { cookie: kohl.cookie },
    payload: { isPublic: true },
  });
  await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/join`,
    headers: { cookie: carol.cookie },
  });
  const a = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie: kohl.cookie },
    payload: { username: 'cass', kind: 'agent', displayName: 'Cass' },
  });
  const agentId = JSON.parse(a.body).id as string;
  const add = await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/agents`,
    headers: { cookie: kohl.cookie },
    payload: { agentId },
  });
  expect(add.statusCode).toBe(201);
  const t = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/tokens`,
    headers: { cookie: kohl.cookie },
    payload: { name: 'plans', scopes: ['plugins:read', 'plugins:write'] },
  });
  wsSent.length = 0; // server setup broadcasts; Plans itself never should
  return {
    serverId,
    kohl: { cookie: kohl.cookie },
    carol: { cookie: carol.cookie },
    bob: { cookie: bob.cookie },
    cass: { token: JSON.parse(t.body).token as string },
  };
}

async function planWithPhase(h: Awaited<ReturnType<typeof house>>, extra = {}) {
  const p = await call('POST', '/plans', h.carol, {
    serverId: h.serverId,
    title: 'Cass picks her own tools',
    goal: 'She decides what to build next',
    ...extra,
  });
  expect(p.status).toBe(201);
  const slug = p.json().slug as string;
  const withPhase = await call('POST', `/plans/${slug}/phases`, h.carol, {
    title: 'Phase 1',
    goal: 'the core',
  });
  const phaseId = withPhase.json().phases[0].id as string;
  const withItem = await call('POST', `/plans/${slug}/items`, h.carol, {
    phaseId,
    kind: 'build',
    title: 'Build the thing',
    body: 'v1',
    owner: 'daedalus',
  });
  const itemId = withItem.json().items[0].id as string;
  return { slug, phaseId, itemId };
}

describe('plans', () => {
  it('members shape plans; outsiders see nothing; every change is on the record', async () => {
    const h = await house();
    const { slug } = await planWithPhase(h);
    const plan = (await call('GET', `/plans/${slug}`, h.kohl)).json();
    expect(plan).toMatchObject({
      title: 'Cass picks her own tools',
      approvers: ['kohl'],
      canApprove: true,
      phases: [{ title: 'Phase 1', status: 'draft' }],
      items: [{ kind: 'build', title: 'Build the thing', owner: 'daedalus', status: 'open' }],
    });
    expect((await call('GET', `/plans/${slug}`, h.carol)).json().canApprove).toBe(false);
    expect((await call('GET', `/plans/${slug}`, h.bob)).status).toBe(404);
    expect((await call('GET', '/plans', h.bob)).json()).toEqual([]);
    expect((await call('POST', '/plans', h.bob, { serverId: h.serverId, title: 'x' })).status).toBe(
      404,
    );

    await call('POST', `/plans/${slug}/comments`, h.cass, { body: 'I want this.' }, 'babelr-organ');
    const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
    expect(events.map((e: { action: string }) => e.action)).toEqual([
      'plan-created',
      'phase-added',
      'item-added',
      'comment',
    ]);
    expect(events[0]).toMatchObject({ actor: { name: 'carol' }, surface: 'plans-view' });
    expect(events[3]).toMatchObject({
      actor: { name: 'cass' },
      surface: 'babelr-organ',
      detail: { body: 'I want this.' },
    });
    expect(wsSent).toEqual([]);
  });

  it('only the owner approves; build work waits for approval; done needs a resolution', async () => {
    const h = await house();
    const { slug, phaseId, itemId } = await planWithPhase(h);
    expect((await call('POST', `/phases/${phaseId}/approve`, h.kohl)).status).toBe(409); // a draft
    await call('POST', `/phases/${phaseId}/propose`, h.carol);
    expect((await call('POST', `/phases/${phaseId}/approve`, h.carol)).status).toBe(403);
    expect((await call('POST', `/phases/${phaseId}/approve`, h.cass)).status).toBe(403);
    expect(
      (await call('POST', `/items/${itemId}/status`, h.carol, { status: 'in_progress' })).status,
    ).toBe(409);

    const approved = (await call('POST', `/phases/${phaseId}/approve`, h.kohl)).json();
    expect(approved.phases[0]).toMatchObject({ status: 'approved', approvals: [{ name: 'kohl' }] });
    expect(
      (await call('POST', `/items/${itemId}/status`, h.carol, { status: 'in_progress' })).status,
    ).toBe(200);
    expect(
      (await call('POST', `/items/${itemId}/status`, h.carol, { status: 'done' })).status,
    ).toBe(400);
    const done = await call('POST', `/items/${itemId}/status`, h.carol, {
      status: 'done',
      resolution: 'shipped in abc1234',
    });
    expect(done.json().items[0]).toMatchObject({
      status: 'done',
      resolution: 'shipped in abc1234',
    });
    // Progress never voids an approval.
    expect(done.json().phases[0].status).toBe('approved');
    const fin = await call('POST', `/phases/${phaseId}/done`, h.kohl, { resolution: 'all in' });
    expect(fin.json().phases[0].status).toBe('done');
    void slug;
  });

  it('a plan that concerns Cass needs her yes too, and only she or the owner can drop her', async () => {
    const h = await house();
    const { slug, phaseId } = await planWithPhase(h, { needsYesFrom: ['cass'] });
    await call('POST', `/phases/${phaseId}/propose`, h.carol);
    let d = (await call('POST', `/phases/${phaseId}/approve`, h.kohl)).json();
    expect(d.approvers).toEqual(['kohl', 'cass']);
    expect(d.phases[0]).toMatchObject({ status: 'proposed', awaiting: ['cass'] });
    const summary = (await call('GET', '/plans', h.cass)).json()[0];
    expect(summary.awaitingMe).toBe(1);
    d = (await call('POST', `/phases/${phaseId}/approve`, h.cass)).json();
    expect(d.phases[0].status).toBe('approved');

    expect((await call('PATCH', `/plans/${slug}`, h.carol, { needsYesFrom: [] })).status).toBe(403);
    expect((await call('PATCH', `/plans/${slug}`, h.cass, { needsYesFrom: [] })).status).toBe(200);
  });

  it('changing what an approved phase says voids the approval', async () => {
    const h = await house();
    const { slug, phaseId, itemId } = await planWithPhase(h);
    await call('POST', `/phases/${phaseId}/propose`, h.carol);
    await call('POST', `/phases/${phaseId}/approve`, h.kohl);

    const edited = await call('PATCH', `/items/${itemId}`, h.carol, { body: 'v2, bigger' });
    expect(edited.json().phases[0]).toMatchObject({ status: 'proposed', approvals: [] });
    await call('POST', `/phases/${phaseId}/approve`, h.kohl);
    const added = await call('POST', `/plans/${slug}/items`, h.carol, {
      phaseId,
      kind: 'research',
      title: 'one more thing',
    });
    expect(added.json().phases[0].status).toBe('proposed');

    const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
    const edit = events.find((e: { action: string }) => e.action === 'item-edited');
    expect(edit.detail.changes.body).toEqual({ before: 'v1', after: 'v2, bigger' });
    expect(events.filter((e: { action: string }) => e.action === 'approval-void')).toHaveLength(2);
  });

  it('reordering items never voids an approval', async () => {
    const h = await house();
    const { slug, phaseId, itemId } = await planWithPhase(h);
    await call('POST', `/plans/${slug}/items`, h.carol, {
      phaseId,
      kind: 'research',
      title: 'second',
    });
    await call('POST', `/phases/${phaseId}/propose`, h.carol);
    await call('POST', `/phases/${phaseId}/approve`, h.kohl);
    const moved = (await call('PATCH', `/items/${itemId}`, h.carol, { position: 99 })).json();
    expect(moved.phases[0].status).toBe('approved');
    expect(moved.items.map((i: { title: string }) => i.title)).toEqual([
      'second',
      'Build the thing',
    ]);
  });

  it('declining needs a reason; a declined phase can be proposed again', async () => {
    const h = await house();
    const { slug, phaseId } = await planWithPhase(h);
    await call('POST', `/phases/${phaseId}/propose`, h.carol);
    expect((await call('POST', `/phases/${phaseId}/decline`, h.kohl, {})).status).toBe(400);
    expect(
      (await call('POST', `/phases/${phaseId}/decline`, h.carol, { reason: 'no' })).status,
    ).toBe(403);
    const d = (
      await call('POST', `/phases/${phaseId}/decline`, h.kohl, { reason: 'too big' })
    ).json();
    expect(d.phases[0]).toMatchObject({ status: 'declined', declineReason: 'too big' });
    expect(
      (await call('POST', `/phases/${phaseId}/propose`, h.carol)).json().phases[0].status,
    ).toBe('proposed');
    void slug;
  });

  it('an agent works through its token, labelled as the api by default', async () => {
    const h = await house();
    const created = await call('POST', '/plans', h.cass, {
      serverId: h.serverId,
      title: 'What I want to learn',
    });
    expect(created.status).toBe(201);
    const slug = created.json().slug;
    const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
    expect(events[0]).toMatchObject({ actor: { name: 'cass' }, surface: 'api' });
    expect(created.json().createdBy.name).toBe('cass');
  });

  it('validates input', async () => {
    const h = await house();
    const { slug, phaseId } = await planWithPhase(h);
    expect(
      (await call('POST', `/plans/${slug}/items`, h.carol, { kind: 'send', title: 'x' })).status,
    ).toBe(400);
    expect((await call('POST', `/plans/${slug}/items`, h.carol, { kind: 'build' })).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', `/plans/${slug}/items`, h.carol, {
          kind: 'build',
          title: 'x',
          phaseId: 'nope',
        })
      ).status,
    ).toBe(400);
    expect((await call('PATCH', `/plans/${slug}`, h.carol, { status: 'shipped' })).status).toBe(
      400,
    );
    expect(
      (await call('PATCH', `/plans/${slug}`, h.carol, { needsYesFrom: ['../x'] })).status,
    ).toBe(400);
    expect((await call('POST', `/phases/${phaseId}/propose`, h.bob)).status).toBe(404);
  });

  it("keeps RoboKohl's eval/ and data/ out of every text field (the wall's backstop)", async () => {
    const h = await house();
    const { slug, phaseId } = await planWithPhase(h);
    const blocked = [
      'see eval/holdout_convs.json',
      'from `data/open/convos.md`',
      'cat ~/robokohl/data/moves_raw.jsonl',
      'in ~/.local/share/robokohl-eval/',
      'the family room at robokohl-family',
      '--- a/eval/ledger/round3.md\n+++ b/eval/ledger/round3.md',
      'ledger_runs has the key',
      'EVAL/ledger/round3.md',
      'diff --git a/eval/x b/eval/x',
    ];
    for (const t of blocked) {
      const r = await call('POST', `/plans/${slug}/items`, h.carol, {
        kind: 'build',
        title: 'x',
        body: t,
        phaseId,
      });
      expect(r.status, t).toBe(400);
      expect(r.json().error, t).toMatch(/wall/);
    }
    expect((await call('PATCH', `/plans/${slug}`, h.carol, { goal: 'read data/x' })).status).toBe(
      400,
    );
    expect(
      (await call('POST', '/plans', h.carol, { serverId: h.serverId, title: 'dump of eval/x' }))
        .status,
    ).toBe(400);
    // Ordinary text about evals and data still goes through.
    for (const t of [
      'the eval ran; data looks good',
      "backend/data/chroma is Cass's",
      'see docs/eval.md',
    ]) {
      const r = await call('POST', `/plans/${slug}/items`, h.carol, {
        kind: 'build',
        title: 'x',
        body: t,
        phaseId,
      });
      expect(r.status, t).toBe(201);
    }
    // Nothing blocked reached the record.
    const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
    expect(JSON.stringify(events)).not.toMatch(/holdout_convs|robokohl-eval|moves_raw/);
  });
});
