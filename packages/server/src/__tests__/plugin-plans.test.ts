// SPDX-License-Identifier: MIT
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

/** A queue file as RoboKohl writes it. */
const RAW = [
  '---',
  'status: pending',
  'kind: email',
  'to: A Researcher  # check the address',
  'room: researchers',
  'why: say hi',
  'created: 2026-10-28',
  'origin: drafted by robokohl',
  '---',
  '',
  'Hello there.',
  '',
].join('\n');

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

  describe("outreach (RoboKohl's queue)", () => {
    async function outreachItem(h: Awaited<ReturnType<typeof house>>) {
      const { slug } = await planWithPhase(h);
      const r = await call('POST', `/plans/${slug}/items`, h.cass, {
        kind: 'outreach',
        title: '0042 A Researcher',
        outreach: { raw: RAW, ref: '0042' },
      });
      expect(r.status).toBe(201);
      const item = r.json().items.find((i: { kind: string }) => i.kind === 'outreach');
      return { slug, item };
    }

    it("a draft goes through Kohl's edit, approval, and a change that voids it, byte for byte", async () => {
      const h = await house();
      const { slug, item } = await outreachItem(h);
      expect(item.outreach).toMatchObject({
        ref: '0042',
        room: 'researchers',
        sendStatus: 'pending',
        rev: 1,
      });
      expect(item.outreach.raw).toBe(RAW);
      expect(item.body).toBe('\nHello there.\n');

      // Kohl's red pen, against revision 1.
      let d = (
        await call('PATCH', `/items/${item.id}`, h.kohl, { body: 'Hi. Short version.', seenRev: 1 })
      ).json();
      let it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach.rev).toBe(2);
      expect(it.outreach.sendStatus).toBe('edited');
      expect(it.outreach.raw).toContain('to: A Researcher  # check the address'); // comments kept
      expect(it.outreach.raw).toContain('edited_by: kohl');
      expect(it.outreach.raw).toContain('<!-- original -->\n\nHello there.\n'); // the original, kept

      // A stale approval is refused; the current one holds.
      expect(
        (await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'approve', rev: 1 }))
          .status,
      ).toBe(409);
      d = (
        await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'approve', rev: 2 })
      ).json();
      it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach).toMatchObject({ sendStatus: 'approved', approvedRev: 2 });

      // An agent revises it (Kohl asked in a DM): the approval is void.
      d = (
        await call('PATCH', `/items/${item.id}`, h.cass, {
          body: 'Hi. Shorter.',
          causeMsg: 'msg-123',
        })
      ).json();
      it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach).toMatchObject({ rev: 3, approvedRev: null, sendStatus: 'edited' });

      const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
      const kohlEdit = events.find(
        (e: { action: string; actor: { name: string } }) =>
          e.action === 'outreach-revised' && e.actor.name !== 'cass',
      );
      expect(kohlEdit.detail.kohlDiff).toContain('+Hi. Short version.');
      expect(kohlEdit.detail.kohlDiff).toContain('-Hello there.');
      const agentEdit = events
        .filter((e: { action: string }) => e.action === 'outreach-revised')
        .pop();
      expect(agentEdit.actor.name).toBe('cass');
      expect(agentEdit.detail.kohlDiff).toBeUndefined();
      expect(agentEdit.detail.causeMsg).toBe('msg-123');
      expect(events.some((e: { action: string }) => e.action === 'send-approval-void')).toBe(true);

      const revs = (await call('GET', `/items/${item.id}/revisions`, h.kohl)).json();
      expect(revs.map((r: { rev: number }) => r.rev)).toEqual([1, 2, 3]);
      expect(revs[0].draft).toBe('\nHello there.\n'); // revision 1 is the original
    });

    it('a phase of drafts is a holding pen: no whole-phase yes, and the page knows who decides a send', async () => {
      const h = await house();
      const { slug, phaseId } = await planWithPhase(h);
      expect((await call('GET', `/plans/${slug}`, h.kohl)).json().phases[0].holdingPen).toBe(false);
      const pen = (
        await call('POST', `/plans/${slug}/phases`, h.carol, { title: 'Waiting on Kohl' })
      ).json().phases[1].id as string;
      await call('POST', `/plans/${slug}/items`, h.cass, {
        phaseId: pen,
        kind: 'outreach',
        title: '0042 A Researcher',
        outreach: { raw: RAW, ref: '0042' },
      });
      const d = (await call('GET', `/plans/${slug}`, h.kohl)).json();
      expect(d.decidesSends).toBe(true);
      expect(d.phases.map((f: { holdingPen: boolean }) => f.holdingPen)).toEqual([false, true]);
      expect((await call('GET', `/plans/${slug}`, h.carol)).json().decidesSends).toBe(false);
      expect((await call('GET', `/plans/${slug}`, h.cass)).json().decidesSends).toBe(false);
      expect((await call('POST', `/phases/${pen}/propose`, h.kohl)).status).toBe(409);
      expect((await call('POST', `/phases/${phaseId}/propose`, h.kohl)).status).toBe(200);
    });

    it('only Kohl, as a person, decides a send: an agent token is refused whatever surface it claims', async () => {
      const h = await house();
      const { item } = await outreachItem(h);
      for (const who of [h.cass, h.carol]) {
        for (const action of ['approve', 'veto', 'sent']) {
          const r = await call(
            'POST',
            `/items/${item.id}/send`,
            who,
            { action, rev: 1, reason: 'x' },
            'plans-view',
          );
          expect(r.status, `${action}`).toBe(403);
        }
      }
    });

    it('a veto needs a reason, kept verbatim; sent outside the queue is said so', async () => {
      const h = await house();
      const { item, slug } = await outreachItem(h);
      expect(
        (await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'veto' })).status,
      ).toBe(400);
      let d = (
        await call('POST', `/items/${item.id}/send`, h.kohl, {
          action: 'veto',
          reason: 'missed\nthe point',
        })
      ).json();
      let it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach.raw).toContain('veto_reason: missed the point');
      expect(it.status).toBe('declined');
      d = (await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'sent' })).json();
      it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach.raw).toContain('sent_outside_queue: true');
      const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
      expect(events.find((e: { action: string }) => e.action === 'send-veto').detail.reason).toBe(
        'missed\nthe point',
      );
      expect(
        events.find((e: { action: string }) => e.action === 'send-sent').detail.outsideQueue,
      ).toBe(true);
    });

    it("Kohl's TUI edits are claimed as Kohl's, marked unverified", async () => {
      const h = await house();
      const { item } = await outreachItem(h);
      const d = (
        await call(
          'PATCH',
          `/items/${item.id}`,
          h.cass,
          { body: 'TUI words.', claimed: 'kohl' },
          'terminal',
        )
      ).json();
      const it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach.raw).toContain('edited_by: kohl');
      expect(it.outreach.raw).toContain('edited_unverified: true');
      const revs = (await call('GET', `/items/${item.id}/revisions`, h.kohl)).json();
      expect(revs[1]).toMatchObject({
        by: 'cass',
        claimed: 'kohl',
        verified: false,
        surface: 'terminal',
      });
      // A person can't claim to be someone else.
      const c = (
        await call('PATCH', `/items/${item.id}`, h.carol, { body: 'Carol words.', claimed: 'kohl' })
      ).json();
      expect(c.items.find((i: { id: string }) => i.id === item.id).outreach.raw).toContain(
        'edited_by: carol',
      );
    });

    it('header fields: to/room void an approval, why/steer do not, status is server-owned', async () => {
      const h = await house();
      const { item } = await outreachItem(h);
      await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'approve', rev: 1 });
      const find = (d: { items: { id: string }[] }) =>
        d.items.find((i) => i.id === item.id) as unknown as {
          outreach: { raw: string; approvedRev: number | null; sendStatus: string; rev: number };
        };

      let it = find(
        (
          await call('PATCH', `/items/${item.id}`, h.cass, { fields: { why: 'say hi, briefly' } })
        ).json(),
      );
      expect(it.outreach).toMatchObject({ approvedRev: 1, sendStatus: 'approved', rev: 1 });
      expect(it.outreach.raw).toContain('why: say hi, briefly');

      it = find(
        (
          await call('PATCH', `/items/${item.id}`, h.cass, { fields: { to: 'Another Researcher' } })
        ).json(),
      );
      expect(it.outreach).toMatchObject({ approvedRev: null, sendStatus: 'edited', rev: 1 });
      expect(it.outreach.raw).toContain('to: Another Researcher  # check the address'); // comment kept
      expect(it.outreach.raw).toContain('edited_by: cass');

      expect(
        (
          await call('PATCH', `/items/${item.id}`, h.cass, {
            body: 'Hi.\n\n<!-- original -->\n\nHello there.\n',
          })
        ).status,
      ).toBe(400); // the original is already kept; a second copy would nest
      for (const fields of [{ status: 'approved' }, { approved_by: 'kohl' }, { to: 'a\nb' }]) {
        expect((await call('PATCH', `/items/${item.id}`, h.cass, { fields })).status).toBe(400);
      }
    });

    it("hold is Kohl's, changes nothing, and keeps an approval", async () => {
      const h = await house();
      const { slug, item } = await outreachItem(h);
      await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'approve', rev: 1 });
      expect(
        (await call('POST', `/items/${item.id}/send`, h.cass, { action: 'hold' })).status,
      ).toBe(403);
      const d = (
        await call('POST', `/items/${item.id}/send`, h.kohl, {
          action: 'hold',
          note: 'after Friday',
        })
      ).json();
      const it = d.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach).toMatchObject({ approvedRev: 1, sendStatus: 'approved' });
      const ev = (await call('GET', `/plans/${slug}/events`, h.kohl)).json().pop();
      expect(ev).toMatchObject({ action: 'send-hold', detail: { rev: 1, note: 'after Friday' } });
    });

    it('find by ref across plans, move between plans, and one event feed for all of them', async () => {
      const h = await house();
      const { slug, item } = await outreachItem(h);
      await call('POST', `/items/${item.id}/send`, h.kohl, { action: 'approve', rev: 1 });
      const other = (
        await call('POST', '/plans', h.carol, {
          serverId: h.serverId,
          title: 'Outreach inbox',
          goal: 'Drafts with no plan yet',
        })
      ).json();

      const found = (await call('GET', '/outreach?ref=0042', h.cass)).json();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: item.id, planSlug: slug, outreach: { ref: '0042' } });
      expect((await call('GET', '/outreach?ref=0043', h.cass)).status).toBe(404);
      expect((await call('GET', '/outreach?ref=0042', h.bob)).status).toBe(404); // not in the server
      expect((await call('GET', '/outreach?ref=42', h.cass)).status).toBe(400);

      expect(
        (await call('PATCH', `/items/${item.id}`, h.cass, { planSlug: other.slug, title: 'x' }))
          .status,
      ).toBe(400); // move first, then edit
      const moved = (
        await call('PATCH', `/items/${item.id}`, h.cass, { planSlug: other.slug })
      ).json();
      expect(moved.slug).toBe(other.slug);
      const it = moved.items.find((i: { id: string }) => i.id === item.id);
      expect(it.outreach).toMatchObject({ approvedRev: 1 }); // a send approval is about the draft
      expect((await call('GET', '/outreach?ref=0042', h.cass)).json()[0].planSlug).toBe(other.slug);

      const feed = (await call('GET', '/events?after=0', h.cass)).json();
      const actions = feed.events.map(
        (e: { planSlug: string; action: string }) => `${e.planSlug}:${e.action}`,
      );
      expect(actions).toContain(`${slug}:item-moved-out`);
      expect(actions).toContain(`${other.slug}:item-moved-in`);
      expect(feed.cursor).toBe(feed.events[feed.events.length - 1].seq);
      const again = (await call('GET', `/events?after=${feed.cursor}`, h.cass)).json();
      expect(again).toEqual({ events: [], cursor: feed.cursor });
      expect((await call('GET', '/events?after=0', h.bob)).json().events).toEqual([]);
    });

    it('imports queue history: any status, drafts as claimed revisions, decisions as events, no approval carried', async () => {
      const h = await house();
      const { slug } = await planWithPhase(h);
      const approved =
        RAW.replace(
          'status: pending',
          'status: approved\napproved: 2026-10-27\napproved_by: kohl',
        ).replace('Hello there.', 'Hi, short.') + '\n<!-- original -->\n\nHello there.\n';
      const body = {
        title: '0007 A Researcher',
        outreach: { ref: '0007', raw: approved },
        revisions: [
          { draft: '\nHello there.\n', by: 'robokohl', at: '2026-10-25', causeMsg: 'git:abc1234' },
          { draft: '\nHi, short.\n\n', by: 'kohl', at: '2026-10-26' },
        ],
        events: [
          { action: 'edited', by: 'kohl', at: '2026-10-26' },
          { action: 'approved', by: 'kohl', at: '2026-10-27' },
          {
            action: 'note',
            by: 'robokohl',
            at: '2026-10-27',
            detail: { wf: 'WF #13: stamped as Kohl' },
          },
        ],
      };
      expect((await call('POST', `/plans/${slug}/items/import`, h.carol, body)).status).toBe(403);
      const bad = { ...body, revisions: body.revisions.slice(0, 1) };
      expect((await call('POST', `/plans/${slug}/items/import`, h.cass, bad)).status).toBe(400);

      const r = await call('POST', `/plans/${slug}/items/import`, h.cass, body);
      expect(r.status).toBe(201);
      const it = r
        .json()
        .items.find((i: { outreach?: { ref: string } }) => i.outreach?.ref === '0007');
      expect(it.status).toBe('open');
      expect(it.outreach).toMatchObject({ sendStatus: 'approved', rev: 2, approvedRev: null });
      expect(it.outreach.raw).toBe(approved);

      const revs = (await call('GET', `/items/${it.id}/revisions`, h.kohl)).json();
      expect(
        revs.map((x: { claimed: string; verified: boolean; surface: string }) => [
          x.claimed,
          x.verified,
          x.surface,
        ]),
      ).toEqual([
        ['robokohl', false, 'import'],
        ['kohl', false, 'import'],
      ]);
      const events = (await call('GET', `/plans/${slug}/events`, h.kohl)).json();
      const mine = events.filter((e: { itemId: string }) => e.itemId === it.id);
      expect(mine.map((e: { action: string }) => e.action)).toEqual([
        'outreach-imported',
        'history-edited',
        'history-approved',
        'history-note',
      ]);
      expect(mine[0].detail.approvalCarried).toBe(false);
      expect(mine[2].detail).toMatchObject({ by: 'kohl', at: '2026-10-27' });
      expect((await call('POST', `/plans/${slug}/items/import`, h.cass, body)).status).toBe(409);

      // Approving it takes Kohl's click on the current revision, like any other.
      const d = (
        await call('POST', `/items/${it.id}/send`, h.kohl, { action: 'approve', rev: 2 })
      ).json();
      expect(d.items.find((i: { id: string }) => i.id === it.id).outreach.approvedRev).toBe(2);
    });

    it('an outreach item needs its room, and never voids its phase approval', async () => {
      const h = await house();
      const { slug, phaseId } = await planWithPhase(h);
      const noRoom = RAW.replace('room: researchers\n', '');
      expect(
        (
          await call('POST', `/plans/${slug}/items`, h.cass, {
            kind: 'outreach',
            title: 'x',
            outreach: { raw: noRoom },
          })
        ).status,
      ).toBe(400);
      await call('POST', `/phases/${phaseId}/propose`, h.carol);
      await call('POST', `/phases/${phaseId}/approve`, h.kohl);
      const d = (
        await call('POST', `/plans/${slug}/items`, h.cass, {
          kind: 'outreach',
          title: 'x',
          phaseId,
          outreach: { raw: RAW },
        })
      ).json();
      expect(d.phases.find((f: { id: string }) => f.id === phaseId).status).toBe('approved');
    });
  });

  describe("on you: what waits on what, and the order of Kohl's list", () => {
    async function items(
      h: Awaited<ReturnType<typeof house>>,
      slug: string,
      phaseId: string,
      specs: [string, string][],
    ) {
      const ids: Record<string, string> = {};
      for (const [title, owner] of specs) {
        const d = (
          await call('POST', `/plans/${slug}/items`, h.carol, {
            phaseId,
            kind: 'build',
            title,
            owner,
          })
        ).json();
        ids[title] = d.items.find((i: { title: string }) => i.title === title).id;
      }
      return ids;
    }
    const titles = (xs: { item: { title: string } }[]) => xs.map((x) => x.item.title);

    it('ready, blocked and stuck; Next is the top three by rank, with no cap per path', async () => {
      const h = await house();
      const { slug, phaseId } = await planWithPhase(h);
      const id = await items(h, slug, phaseId, [
        ['hired', 'kohl'],
        ['patrons', 'kohl'],
        ['contract', 'kohl'],
        ['fourth', 'kohl'],
        ['after hired', 'kohl'],
        ['build it', 'daedalus'],
        ['after build', 'kohl'],
        ['vetoed thing', 'kohl'],
        ['after veto', 'kohl'],
      ]);
      const after = (t: string, on: string[]) =>
        call('PATCH', `/items/${id[t]}`, h.cass, { after: on.map((o) => id[o]) });
      expect((await after('after hired', ['hired'])).status).toBe(200);
      await after('after build', ['build it']);
      await after('after veto', ['vetoed thing']);
      await call('POST', `/items/${id['vetoed thing']}/status`, h.kohl, { status: 'declined' });
      // A loop is refused.
      expect((await after('hired', ['after hired'])).status).toBe(409);
      // RoboKohl ranks; three parallel paths can all be Next.
      for (const [t, r] of [
        ['contract', 1],
        ['patrons', 2],
        ['hired', 3],
      ] as const) {
        await call('PATCH', `/items/${id[t]}`, h.cass, { rank: r, why: `why ${t}` });
      }
      const on = (await call('GET', '/on-you', h.kohl)).json();
      expect(titles(on.next)).toEqual(['contract', 'patrons', 'hired']);
      expect(on.next[2].unlocks).toBe(1); // "after hired"
      expect(on.next[0].item.why).toBe('why contract');
      expect(titles(on.more)).toEqual(['fourth']);
      expect(titles(on.blocked).sort()).toEqual(['after build', 'after hired']);
      const wait = on.blocked.find(
        (b: { item: { title: string } }) => b.item.title === 'after build',
      );
      expect(wait.waitingOn).toEqual([
        { id: id['build it'], title: 'build it', owner: 'daedalus' },
      ]);
      expect(titles(on.stuck)).toEqual(['after veto']);
      expect(on.stuck[0].stuckOn.title).toBe('vetoed thing');
      // The map: one act per linked piece with Kohl work left; lone items stay in the list.
      expect(on.acts).toHaveLength(3);
      const act = on.acts.find((x: { rows: string[][] }) => x.rows[0][0] === id.hired);
      expect(act.rows).toEqual([[id.hired], [id['after hired']]]);
      expect(act.tops).toEqual([id['after hired']]);
      expect(act.boss.goal).toBe('She decides what to build next');
      expect(act.nodes[id.hired]).toMatchObject({ state: 'lit', next: 3 });
      expect(act.nodes[id['after hired']].state).toBe('locked');
      const built = on.acts.find((x: { rows: string[][] }) => x.rows[0][0] === id['build it']);
      expect(built.nodes[id['build it']].state).toBe('waiting');
      const vetoed = on.acts.find((x: { rows: string[][] }) => x.rows[0][0] === id['vetoed thing']);
      expect(vetoed.nodes[id['after veto']].state).toBe('stuck');
      // An agent reads the same list.
      expect(titles((await call('GET', '/on-you', h.cass)).json().next)).toEqual(titles(on.next));

      // Upstream done: the next one up is ready.
      await call('POST', `/items/${id['build it']}/status`, h.carol, {
        status: 'done',
        resolution: 'x',
      });
      const on2 = (await call('GET', '/on-you', h.kohl)).json();
      expect(titles(on2.more)).toContain('after build');
      expect(titles(on2.shipped)).toEqual(['build it']);
    });

    it("Kohl's rank is pinned against agents, and ordering never voids an approval", async () => {
      const h = await house();
      const { slug, phaseId, itemId } = await planWithPhase(h);
      const id = await items(h, slug, phaseId, [['mine', 'kohl']]);
      await call('POST', `/phases/${phaseId}/propose`, h.carol);
      await call('POST', `/phases/${phaseId}/approve`, h.kohl);
      let d = (await call('PATCH', `/items/${id.mine}`, h.kohl, { rank: 1 })).json();
      expect(d.items.find((i: { id: string }) => i.id === id.mine)).toMatchObject({
        rank: 1,
        rankedBy: 'kohl',
      });
      expect((await call('PATCH', `/items/${id.mine}`, h.cass, { rank: 2 })).status).toBe(409);
      // Why and links are still the agent's to set; none of it voids the phase's yes.
      d = (
        await call('PATCH', `/items/${id.mine}`, h.cass, {
          why: 'it unblocks the rest',
          after: [itemId],
        })
      ).json();
      expect(d.phases[0].status).toBe('approved');
      expect(d.items.find((i: { id: string }) => i.id === id.mine).after).toEqual([itemId]);
      // Kohl clears the pin; then the agent can rank it.
      await call('PATCH', `/items/${id.mine}`, h.kohl, { rank: null });
      expect((await call('PATCH', `/items/${id.mine}`, h.cass, { rank: 2 })).status).toBe(200);
      expect((await call('PATCH', `/items/${id.mine}`, h.cass, { why: 'two\nlines' })).status).toBe(
        400,
      );
    });

    it('proposed phases and outreach drafts waiting on a send are on Kohl too', async () => {
      const h = await house();
      const { slug, phaseId } = await planWithPhase(h);
      await call('POST', `/phases/${phaseId}/propose`, h.carol);
      const p2 = (await call('POST', `/plans/${slug}/phases`, h.carol, { title: 'Phase 2' })).json()
        .phases[1].id as string;
      await call('POST', `/plans/${slug}/items`, h.carol, {
        phaseId: p2,
        kind: 'build',
        title: 'b',
      });
      await call('POST', `/phases/${p2}/propose`, h.carol);
      await call('POST', `/plans/${slug}/items`, h.cass, {
        kind: 'outreach',
        title: '0042 A Researcher',
        outreach: { raw: RAW, ref: '0042' },
      });
      const on = (await call('GET', '/on-you', h.kohl)).json();
      expect(on.phases.map((p: { phase: { title: string } }) => p.phase.title)).toEqual([
        'Phase 1',
        'Phase 2',
      ]);
      // One per plan first: a plan's later phases mostly follow its earlier ones.
      expect(on.phasesNext.map((p: { phase: { title: string } }) => p.phase.title)).toEqual([
        'Phase 1',
      ]);
      expect(titles(on.next)).toEqual(['0042 A Researcher']);
    });
  });
});
