// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from './helpers.ts';

/**
 * Review plugin, through the real plugin loader: an agent pushes drafts
 * to its sponsor, the sponsor decides, the agent reads the decision and
 * closes the item. Nobody else sees any of it.
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
  await db.execute(sql`TRUNCATE plugin_review_items CASCADE`);
  wsSent.length = 0;
});

type Who = { cookie?: string; token?: string };

async function call(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  who: Who,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/plugins/review${url}`,
    headers: who.token ? { authorization: `Bearer ${who.token}` } : { cookie: who.cookie ?? '' },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, json: () => JSON.parse(res.body), body: res.body };
}

/** Kohl sponsors agent robo (plugins:read/write token); mallory is someone else. */
async function cast() {
  const kohl = await createTestUser(app, 'kohl');
  const mallory = await createTestUser(app, 'mallory');
  const a = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie: kohl.cookie },
    payload: { username: 'robo', kind: 'agent', displayName: 'Robo' },
  });
  const agentId = JSON.parse(a.body).id as string;
  const t = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/tokens`,
    headers: { cookie: kohl.cookie },
    payload: { name: 'review', scopes: ['plugins:read', 'plugins:write'] },
  });
  return {
    kohl: { cookie: kohl.cookie },
    mallory: { cookie: mallory.cookie },
    robo: { token: JSON.parse(t.body).token as string },
  };
}

const ITEM = {
  title: 'email → Frictional Games',
  meta: 'pending · 6d',
  why: 'Because.',
  body: 'Dear F,\n\nhi',
};

describe('review plugin', () => {
  it("an agent's draft reaches its sponsor, and nobody else", async () => {
    const { kohl, mallory, robo } = await cast();
    const put = await call('PUT', '/items/0001', robo, ITEM);
    expect(put.status).toBe(200);
    expect(put.json()).toMatchObject({ changed: true, item: { ref: '0001', revision: 1 } });

    const inbox = await call('GET', '/inbox', kohl);
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0]).toMatchObject({
      ref: '0001',
      title: ITEM.title,
      body: ITEM.body,
      decision: null,
      agent: { preferredUsername: 'robo', displayName: 'Robo' },
    });
    expect((await call('GET', '/inbox', mallory)).json()).toEqual([]);
    const id = inbox.json()[0].id;
    expect(
      (await call('POST', `/items/${id}/decision`, mallory, { decision: 'approve' })).status,
    ).toBe(404);
    expect(wsSent).toEqual([]);
  });

  it('only agents push; people review; agents do not review', async () => {
    const { kohl, robo } = await cast();
    expect((await call('PUT', '/items/0001', kohl, ITEM)).status).toBe(403);
    expect((await call('GET', '/inbox', robo)).status).toBe(403);
    await call('PUT', '/items/0001', robo, ITEM);
    const id = (await call('GET', '/inbox', kohl)).json()[0].id;
    expect(
      (await call('POST', `/items/${id}/decision`, robo, { decision: 'approve' })).status,
    ).toBe(403);
    expect((await call('PUT', '/items/..%2Fx', robo, ITEM)).status).toBe(400);
    expect((await call('PUT', '/items/0002', robo, { ...ITEM, body: ' ' })).status).toBe(400);
  });

  it('decides: veto needs a reason, edit needs a draft; the agent reads it, then closes it', async () => {
    const { kohl, robo } = await cast();
    await call('PUT', '/items/0001', robo, ITEM);
    const id = (await call('GET', '/inbox', kohl)).json()[0].id;
    const decide = (b: unknown) => call('POST', `/items/${id}/decision`, kohl, b);

    expect((await decide({ decision: 'veto' })).status).toBe(400);
    expect((await decide({ decision: 'edit' })).status).toBe(400);
    expect((await decide({ decision: 'send' })).status).toBe(400);
    expect((await decide({ decision: 'edit', body: 'Dear F, shorter' })).json()).toMatchObject({
      decision: 'edit',
      editedBody: 'Dear F, shorter',
    });
    // Changing your mind is fine until the agent acts.
    const vetoed = (await decide({ decision: 'veto', reason: 'too long' })).json();
    expect(vetoed).toMatchObject({ decision: 'veto', reason: 'too long', editedBody: null });

    const mine = (await call('GET', '/items', robo)).json();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ref: '0001', decision: 'veto', reason: 'too long' });

    expect((await call('DELETE', '/items/0001', robo)).status).toBe(200);
    expect((await call('GET', '/inbox', kohl)).json()).toEqual([]);
    expect((await call('GET', '/items', robo)).json()).toEqual([]);
    expect((await decide({ decision: 'approve' })).status).toBe(404);
  });

  it('pushing the same draft is a no-op; a new draft reopens and clears the decision', async () => {
    const { kohl, robo } = await cast();
    await call('PUT', '/items/0001', robo, ITEM);
    const id = (await call('GET', '/inbox', kohl)).json()[0].id;
    await call('POST', `/items/${id}/decision`, kohl, { decision: 'hold' });

    const same = await call('PUT', '/items/0001', robo, ITEM);
    expect(same.json()).toMatchObject({ changed: false, item: { revision: 1, decision: 'hold' } });

    const changed = await call('PUT', '/items/0001', robo, { ...ITEM, body: 'Dear F, v2' });
    expect(changed.json()).toMatchObject({
      changed: true,
      item: { revision: 2, decision: null, body: 'Dear F, v2' },
    });

    // Closed, then pushed again (the same content): back in the inbox.
    await call('DELETE', '/items/0001', robo);
    const again = await call('PUT', '/items/0001', robo, { ...ITEM, body: 'Dear F, v2' });
    expect(again.json()).toMatchObject({ changed: true, item: { revision: 3 } });
    expect((await call('GET', '/inbox', kohl)).json()).toHaveLength(1);
  });
});

describe('review chat', () => {
  it('the reviewer and the agent talk an item over; the agent sees what it owes', async () => {
    const { kohl, robo } = await cast();
    await call('PUT', '/items/0001', robo, ITEM);
    const id = (await call('GET', '/inbox', kohl)).json()[0].id;

    const asked = await call('POST', `/items/${id}/messages`, kohl, {
      body: 'shorter, and lose the PS',
    });
    expect(asked.status).toBe(201);
    let mine = (await call('GET', '/items', robo)).json()[0];
    expect(mine).toMatchObject({ messageCount: 1, awaitingReply: true });

    // The agent addresses the item by its own ref.
    const thread = (await call('GET', '/items/0001/messages', robo)).json();
    expect(thread).toEqual([
      expect.objectContaining({ from: 'reviewer', body: 'shorter, and lose the PS' }),
    ]);
    await call('POST', '/items/0001/messages', robo, { body: 'done: new draft is up' });
    await call('PUT', '/items/0001', robo, { ...ITEM, body: 'Dear F, short' });
    mine = (await call('GET', '/items', robo)).json()[0];
    expect(mine).toMatchObject({ messageCount: 2, awaitingReply: false, revision: 2 });

    const inbox = (await call('GET', '/inbox', kohl)).json()[0];
    expect(inbox).toMatchObject({ body: 'Dear F, short', decision: null, messageCount: 2 });
    const seen = (await call('GET', `/items/${id}/messages`, kohl)).json();
    expect(seen.map((m: { from: string; authorName: string }) => [m.from, m.authorName])).toEqual([
      ['reviewer', 'kohl'],
      ['agent', 'Robo'],
    ]);
  });

  it('nobody else reads or writes the chat, and a closed item has none', async () => {
    const { kohl, mallory, robo } = await cast();
    await call('PUT', '/items/0001', robo, ITEM);
    const id = (await call('GET', '/inbox', kohl)).json()[0].id;
    await call('POST', `/items/${id}/messages`, kohl, { body: 'private' });
    expect((await call('GET', `/items/${id}/messages`, mallory)).status).toBe(404);
    expect((await call('POST', `/items/${id}/messages`, mallory, { body: 'x' })).status).toBe(404);
    expect((await call('POST', `/items/${id}/messages`, kohl, { body: '  ' })).status).toBe(400);
    expect((await call('GET', `/items/${id}/messages`, robo)).status).toBe(404); // agents use refs
    await call('DELETE', '/items/0001', robo);
    expect((await call('GET', `/items/${id}/messages`, kohl)).status).toBe(404);
    expect(wsSent).toEqual([]);
  });
});

describe('review history', () => {
  it('lists closed items newest first, with the decision; only to the reviewer', async () => {
    const { kohl, mallory, robo } = await cast();
    await call('PUT', '/items/0001', robo, ITEM);
    await call('PUT', '/items/0002', robo, ITEM);
    await call('PUT', '/items/0003', robo, ITEM);
    const inbox = (await call('GET', '/inbox', kohl)).json();
    const id = (ref: string) => inbox.find((i: { ref: string }) => i.ref === ref).id;
    await call('POST', `/items/${id('0001')}/decision`, kohl, { decision: 'veto', reason: 'no' });
    await call('DELETE', '/items/0001', robo);
    await call('DELETE', '/items/0002', robo); // decided elsewhere: no decision here

    const history = (await call('GET', '/history', kohl)).json();
    expect(history.map((i: { ref: string }) => i.ref)).toEqual(['0002', '0001']);
    expect(history[1]).toMatchObject({ decision: 'veto', reason: 'no' });
    expect(history[1].closedAt).not.toBeNull();
    expect(history[0].decision).toBeNull();
    expect((await call('GET', '/inbox', kohl)).json().map((i: { ref: string }) => i.ref)).toEqual([
      '0003',
    ]);
    expect((await call('GET', '/history', mallory)).json()).toEqual([]);
    expect((await call('GET', '/history', robo)).status).toBe(403);
  });
});
