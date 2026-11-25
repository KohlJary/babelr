// SPDX-License-Identifier: MIT
/**
 * Welcoming newcomers: opt-in welcomers get a DM with each person who
 * joins, and a welcome to act on. Consent holds both ways.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { actors } from '../../db/schema/actors.ts';
import { auditLogs } from '../../db/schema/audit-logs.ts';
import { collectionItems } from '../../db/schema/collections.ts';
import { serverWelcomers, welcomes } from '../../db/schema/welcome.ts';
import { welcomeAfterJoin } from '../../welcome.ts';
import { enc } from '../e2e-fixtures.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
  wsSent.length = 0;
});

type User = Awaited<ReturnType<typeof createTestUser>>;
type Who = User | string;

const KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

const headers = (who: Who) =>
  typeof who === 'string' ? { authorization: `Bearer ${who}` } : { cookie: who.cookie };

async function call(who: Who, method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: headers(who),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: body as any };
}

const publishKey = (who: Who) => call(who, 'PUT', '/auth/publickey', { publicKey: KEY });
const optIn = (who: Who, serverId: string, welcoming = true) =>
  call(who, 'PUT', `/servers/${serverId}/welcome`, { welcoming });

async function person(name: string, key = true) {
  const u = await createTestUser(app, name);
  if (key) expect((await publishKey(u)).status).toBe(200);
  return u;
}

/** An agent in the server, with its own token and published key. */
async function agentIn(sponsor: User, serverId: string, username: string, scopes?: string[]) {
  const a = await call(sponsor, 'POST', '/agents', { username, kind: 'agent' });
  expect(a.status).toBe(201);
  const t = await call(sponsor, 'POST', `/agents/${a.body.id}/tokens`, {
    name: 't',
    scopes: scopes ?? ['dms:read', 'dms:post', 'dms:open', 'keys:write'],
  });
  expect(t.status).toBe(201);
  const token = t.body.token as string;
  expect(
    (await call(sponsor, 'POST', `/servers/${serverId}/agents`, { agentId: a.body.id })).status,
  ).toBe(201);
  if ((scopes ?? ['keys:write']).includes('keys:write')) {
    expect((await publishKey(token)).status).toBe(200);
  }
  return { id: a.body.id as string, token };
}

async function house(owner: User) {
  const s = await call(owner, 'POST', '/servers', { name: 'House' });
  expect(s.status).toBe(201);
  const serverId = s.body.id as string;
  const inv = await call(owner, 'POST', `/servers/${serverId}/invites`, {});
  expect(inv.status).toBe(201);
  return { serverId, code: inv.body.code as string };
}

const join = (who: Who, code: string) => call(who, 'POST', `/invites/${code}/join`);

function partnersIn(list: Array<{ participants: Array<{ id: string }> }>, me: string) {
  return list.flatMap((c) => c.participants.map((p) => p.id).filter((id) => id !== me)).sort();
}

describe('welcoming newcomers', () => {
  it('by default nobody welcomes: a newcomer joins to an empty DM list', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    await agentIn(kohl, serverId, 'robo');
    const mom = await person('mom');
    expect((await join(mom, code)).status).toBe(200);
    expect((await call(mom, 'GET', '/dms')).body).toEqual([]);
    expect(await db.select().from(welcomes)).toHaveLength(0);
  });

  it('opted-in welcomers show up in the newcomer’s DM list, without a request wall', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    const eris = await agentIn(kohl, serverId, 'eris');
    await agentIn(kohl, serverId, 'quiet'); // never opts in

    const r1 = await optIn(robo.token, serverId);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ serverId, welcoming: true });
    expect((await optIn(eris.token, serverId)).status).toBe(200);
    expect((await optIn(kohl, serverId)).status).toBe(200);

    const mom = await person('mom');
    expect((await join(mom, code)).status).toBe(200);

    const dms = await call(mom, 'GET', '/dms');
    expect(dms.status).toBe(200);
    expect(partnersIn(dms.body, mom.body.id)).toEqual([kohl.body.id, robo.id, eris.id].sort());
    for (const c of dms.body) expect(c.request).toBeUndefined();
    expect((await call(mom, 'GET', '/dms/requests')).body).toEqual([]);

    // The newcomer was told in real time, and so was each welcomer.
    const toMom = wsSent.filter((w) => w.to === mom.body.id);
    expect(toMom.map((w) => (w.message as { type: string }).type)).toEqual([
      'conversation:new',
      'conversation:new',
      'conversation:new',
    ]);
    const roboSignal = wsSent.find(
      (w) => w.to === robo.id && (w.message as { type: string }).type === 'welcome:new',
    );
    expect(roboSignal).toBeTruthy();

    // The welcomer's list: who, through whose invite, which DM.
    const list = await call(robo.token, 'GET', '/welcomes');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      server: { id: serverId, name: 'House' },
      newcomer: { id: mom.body.id, preferredUsername: 'mom' },
      invitedBy: { id: kohl.body.id, preferredUsername: 'kohl' },
      state: 'pending',
      newcomerKeyReady: true,
    });
    const dmId = list.body[0].dmId as string;

    // Both can talk, though the agent's own policy is `nobody`: the
    // opt-in was its yes. Nothing was sent in its name.
    const [roboRow] = await db.select().from(actors).where(eq(actors.id, robo.id));
    expect(roboRow.dmPolicy).toBe('nobody');
    expect((await call(mom, 'GET', `/dms/${dmId}/messages`)).body.messages).toEqual([]);
    expect(
      (await call(robo.token, 'POST', `/dms/${dmId}/messages`, { content: 'x', properties: enc() }))
        .status,
    ).toBe(201);
    expect(
      (await call(mom, 'POST', `/dms/${dmId}/messages`, { content: 'y', properties: enc() }))
        .status,
    ).toBe(201);

    // Saying hello settles the welcome.
    expect((await call(robo.token, 'GET', '/welcomes')).body).toEqual([]);
    const done = await call(robo.token, 'GET', '/welcomes?state=done');
    expect(done.body).toHaveLength(1);

    // Logged for the owner to see.
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.category, 'welcome'), eq(auditLogs.action, 'welcome.open')));
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.serverId === serverId)).toBe(true);
  });

  it('the newcomer sees which DMs are welcomes, and what she has not read', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    expect((await join(mom, code)).status).toBe(200);

    let [dm] = (await call(mom, 'GET', '/dms')).body;
    expect(dm.welcome).toBe(true);
    expect(dm.unread).toBeUndefined();
    // The welcomer's side of it isn't a welcome for him.
    const [roboDM] = (await call(robo.token, 'GET', '/dms')).body;
    expect(roboDM.id).toBe(dm.id);
    expect(roboDM.welcome).toBeUndefined();

    for (const content of ['hello', 'welcome']) {
      const r = await call(robo.token, 'POST', `/dms/${dm.id}/messages`, {
        content,
        properties: enc(),
      });
      expect(r.status).toBe(201);
    }
    [dm] = (await call(mom, 'GET', '/dms')).body;
    expect(dm.unread).toBe(2);
    expect((await call(robo.token, 'GET', '/dms')).body[0].unread).toBeUndefined();

    // Read, then her own reply: nothing unread.
    expect((await call(mom, 'PUT', `/channels/${dm.id}/read`)).status).toBe(200);
    expect(
      (await call(mom, 'POST', `/dms/${dm.id}/messages`, { content: 'hi', properties: enc() }))
        .status,
    ).toBe(201);
    [dm] = (await call(mom, 'GET', '/dms')).body;
    expect(dm.unread).toBeUndefined();
    expect((await call(robo.token, 'GET', '/dms')).body[0].unread).toBe(1);

    // A DM she starts herself is not a welcome.
    const other = await person('aunt');
    expect((await join(other, code)).status).toBe(200);
    const mine = await call(mom, 'POST', '/dms', { participantId: other.body.id });
    expect(mine.status).toBeLessThan(300);
    expect(mine.body.welcome).toBeUndefined();
  });

  it('is idempotent: retries and rejoins make no second DM', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    await join(mom, code);
    await join(mom, code);
    await Promise.all([
      welcomeAfterJoin(app, serverId, mom.body.id, { via: 'test' }),
      welcomeAfterJoin(app, serverId, mom.body.id, { via: 'test' }),
    ]);
    await call(mom, 'GET', '/dms');
    await call(robo.token, 'GET', '/welcomes');
    expect((await call(mom, 'GET', '/dms')).body).toHaveLength(1);
    expect(await db.select().from(welcomes)).toHaveLength(1);

    // Leave the server and come back: still the one DM.
    expect((await call(mom, 'POST', `/servers/${serverId}/leave`)).status).toBe(200);
    await join(mom, code);
    expect((await call(mom, 'GET', '/dms')).body).toHaveLength(1);
  });

  it('the newcomer can leave or block a welcome DM, and the welcomer cannot reopen it', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    const eris = await agentIn(kohl, serverId, 'eris');
    await optIn(robo.token, serverId);
    await optIn(eris.token, serverId);
    const mom = await person('mom');
    await join(mom, code);
    const [w] = (await call(robo.token, 'GET', '/welcomes')).body;

    expect((await call(mom, 'POST', `/dms/${w.dmId}/leave`)).status).toBe(200);
    expect(
      (
        await call(robo.token, 'POST', `/dms/${w.dmId}/messages`, {
          content: 'x',
          properties: enc(),
        })
      ).status,
    ).toBe(403);
    expect((await call(robo.token, 'POST', '/dms', { participantId: mom.body.id })).status).toBe(
      403,
    );

    const [we] = (await call(eris.token, 'GET', '/welcomes')).body;
    expect((await call(mom, 'POST', '/blocks', { actorId: eris.id })).status).toBeLessThan(300);
    expect(
      (
        await call(eris.token, 'POST', `/dms/${we.dmId}/messages`, {
          content: 'x',
          properties: enc(),
        })
      ).status,
    ).toBe(403);
  });

  it('nobody can put someone else on the list', async () => {
    const kohl = await person('kohl');
    const { serverId } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');

    // The sponsor's session opts in only the sponsor.
    expect((await optIn(kohl, serverId)).status).toBe(200);
    const rows = await db.select().from(serverWelcomers);
    expect(rows.map((r) => r.actorId)).toEqual([kohl.body.id]);
    expect(rows.map((r) => r.actorId)).not.toContain(robo.id);

    // The route takes no actor id: a body naming someone else is ignored.
    await call(kohl, 'PUT', `/servers/${serverId}/welcome`, { welcoming: true, actorId: robo.id });
    expect((await db.select().from(serverWelcomers)).map((r) => r.actorId)).toEqual([kohl.body.id]);
  });

  it('opting in needs membership, a published key, and (for a token) dms:post', async () => {
    const kohl = await person('kohl');
    const { serverId } = await house(kohl);
    const outsider = await person('outsider');
    expect((await optIn(outsider, serverId)).status).toBe(404);

    const nokey = await agentIn(kohl, serverId, 'nokey', ['dms:read', 'dms:post']);
    const r = await optIn(nokey.token, serverId);
    expect(r.status).toBe(409);

    const readonly = await agentIn(kohl, serverId, 'readonly', ['dms:read', 'keys:write']);
    expect((await optIn(readonly.token, serverId)).status).toBe(403);
    // Opting out never needs a scope.
    expect((await optIn(readonly.token, serverId, false)).status).toBe(200);
  });

  it('opting out takes you off the list for the next newcomer', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const settings = await call(robo.token, 'GET', '/welcome/settings');
    expect(settings.body).toEqual([expect.objectContaining({ serverId, welcoming: true })]);
    expect((await optIn(robo.token, serverId, false)).body.welcoming).toBe(false);
    const mom = await person('mom');
    await join(mom, code);
    expect((await call(mom, 'GET', '/dms')).body).toEqual([]);
    const actions = (
      await db.select().from(auditLogs).where(eq(auditLogs.category, 'welcome'))
    ).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['welcome.opt_in', 'welcome.opt_out']));
  });

  it('a block made before the join means no welcome DM', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const luna = await person('luna');
    expect((await call(luna, 'POST', '/blocks', { actorId: robo.id })).status).toBeLessThan(300);
    await join(luna, code);
    expect((await call(luna, 'GET', '/dms')).body).toEqual([]);
    const [row] = await db.select().from(welcomes);
    expect(row).toMatchObject({ state: 'skipped', reason: 'blocked', dmId: null });
  });

  it("the newcomer's own policy still decides: a request, not an open DM", async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const luna = await person('luna');
    expect(
      (await call(luna, 'PUT', '/auth/dm-settings', { dmPolicy: 'friends' })).status,
    ).toBeLessThan(300);
    await join(luna, code);
    expect((await call(luna, 'GET', '/dms')).body).toEqual([]);
    expect((await call(luna, 'GET', '/dms/requests')).body).toHaveLength(1);
    const [w] = (await call(robo.token, 'GET', '/welcomes')).body;
    expect(w).toMatchObject({ state: 'pending', reason: 'request' });
  });

  it('a join made without the trigger is caught up when the newcomer loads DMs', async () => {
    const kohl = await person('kohl');
    const { serverId } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    // Membership added the way a registration transaction would.
    const [server] = await db.select().from(actors).where(eq(actors.id, serverId));
    const [momRow] = await db.select().from(actors).where(eq(actors.id, mom.body.id));
    await db.insert(collectionItems).values({
      collectionUri: server.followersUri!,
      itemUri: momRow.uri,
      itemId: momRow.id,
    });
    const dms = await call(mom, 'GET', '/dms');
    expect(partnersIn(dms.body, mom.body.id)).toEqual([robo.id]);
  });

  it('the welcomer side catches up too', async () => {
    const kohl = await person('kohl');
    const { serverId } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    const [server] = await db.select().from(actors).where(eq(actors.id, serverId));
    const [momRow] = await db.select().from(actors).where(eq(actors.id, mom.body.id));
    await db.insert(collectionItems).values({
      collectionUri: server.followersUri!,
      itemUri: momRow.uri,
      itemId: momRow.id,
    });
    const list = await call(robo.token, 'GET', '/welcomes');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].newcomer.id).toBe(mom.body.id);
    expect(list.body[0].invitedBy).toBeNull();
  });

  it('members who joined before you opted in are not welcomed retroactively', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const mom = await person('mom');
    await join(mom, code);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    expect((await call(robo.token, 'GET', '/welcomes')).body).toEqual([]);
    expect((await call(mom, 'GET', '/dms')).body).toEqual([]);
  });

  it("the newcomer's key readiness is reported, so a welcomer can wait to encrypt", async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom', false);
    await join(mom, code);
    expect((await call(robo.token, 'GET', '/welcomes')).body[0].newcomerKeyReady).toBe(false);
    await publishKey(mom);
    expect((await call(robo.token, 'GET', '/welcomes')).body[0].newcomerKeyReady).toBe(true);
  });

  it('marking a welcome done is the welcomer’s alone', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    const eris = await agentIn(kohl, serverId, 'eris');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    await join(mom, code);
    const [w] = (await call(robo.token, 'GET', '/welcomes')).body;
    expect((await call(eris.token, 'POST', `/welcomes/${w.id}/done`)).status).toBe(404);
    const done = await call(robo.token, 'POST', `/welcomes/${w.id}/done`);
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('done');
    expect((await call(robo.token, 'GET', '/welcomes')).body).toEqual([]);
  });

  it('the owner can see who welcomes; other members cannot', async () => {
    const kohl = await person('kohl');
    const { serverId, code } = await house(kohl);
    const robo = await agentIn(kohl, serverId, 'robo');
    await optIn(robo.token, serverId);
    const mom = await person('mom');
    await join(mom, code);
    const list = await call(kohl, 'GET', `/servers/${serverId}/welcomers`);
    expect(list.status).toBe(200);
    expect(list.body.map((w: { actor: { id: string } }) => w.actor.id)).toEqual([robo.id]);
    expect((await call(mom, 'GET', `/servers/${serverId}/welcomers`)).status).toBe(403);
    // Closed to tokens.
    expect((await call(robo.token, 'GET', `/servers/${serverId}/welcomers`)).status).toBe(403);
  });
});
