// SPDX-License-Identifier: Hippocratic-3.0
/**
 * DM consent (step 3d): "nobody is anyone's bitch". Everyone can say
 * no (policies, requests, blocks) and everyone can leave.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb, wsSent } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { actors } from '../../db/schema/actors.ts';
import { agentTokens } from '../../db/schema/agent-tokens.ts';
import { auditLogs } from '../../db/schema/audit-logs.ts';
import { friendships } from '../../db/schema/friendships.ts';
import { dmRequests } from '../../db/schema/dm-consent.ts';
import { serverAgentGrants } from '../../db/schema/server-agent-grants.ts';
import { REFUSED_OPEN } from '../../dm-consent.ts';

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
type Auth = { cookie: string } | { authorization: string };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const as = (who: User | string): Auth =>
  typeof who === 'string' ? bearer(who) : { cookie: who.cookie };

async function call(who: User | string, method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: as(who),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as Record<string, unknown> & unknown[] };
}

const openDM = (who: User | string, participantId: string) =>
  call(who, 'POST', '/dms', { participantId });
const say = (who: User | string, dmId: string, content: string) =>
  call(who, 'POST', `/dms/${dmId}/messages`, { content });

async function createAgent(sponsor: User, username: string, extra: Record<string, unknown> = {}) {
  const res = await call(sponsor, 'POST', '/agents', { username, kind: 'agent', ...extra });
  expect(res.status).toBe(201);
  return res.body as unknown as { id: string; dmPolicy: string; dmPolicySetBy: string | null };
}

async function mint(sponsor: User, agentId: string, scopes: string[]) {
  const res = await call(sponsor, 'POST', `/agents/${agentId}/tokens`, { name: 't', scopes });
  expect(res.status).toBe(201);
  return (res.body as unknown as { token: string }).token;
}

async function befriend(a: User, b: User) {
  await db.insert(friendships).values([
    { ownerActorId: a.body.id, otherActorId: b.body.id, state: 'accepted' },
    { ownerActorId: b.body.id, otherActorId: a.body.id, state: 'accepted' },
  ]);
}

async function setPolicy(who: User | string, dmPolicy: string) {
  const res = await call(who, 'PUT', '/auth/dm-settings', { dmPolicy });
  expect(res.status).toBe(200);
}

async function auditFor(actorId: string, action: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, actorId), eq(auditLogs.action, action)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

describe('Defaults', () => {
  it("people keep today's behavior (anyone); agents start at nobody", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const mine = await call(kohl, 'GET', '/auth/dm-settings');
    expect(mine.body).toMatchObject({ dmPolicy: 'anyone', setBy: null, allowlist: [] });

    const agent = await createAgent(kohl, 'robo');
    expect(agent).toMatchObject({ dmPolicy: 'nobody', dmPolicySetBy: null });
    const tok = await mint(kohl, agent.id, []);
    const its = await call(tok, 'GET', '/auth/dm-settings');
    expect(its.status).toBe(200);
    expect(its.body).toMatchObject({ dmPolicy: 'nobody', setBy: null });
  });

  it('rejects an unknown policy', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const res = await call(kohl, 'PUT', '/auth/dm-settings', { dmPolicy: 'everyone-ish' });
    expect(res.status).toBe(400);
    const bad = await call(kohl, 'POST', '/agents', {
      username: 'robo',
      kind: 'agent',
      dmPolicy: 'sure',
    });
    expect(bad.status).toBe(400);
  });
});

describe("An agent's DMs are its own", () => {
  it("its own sponsor can't DM an agent whose policy is nobody until the agent allows it", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl, 'robo');

    const refused = await openDM(kohl, agent.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(REFUSED_OPEN);

    // The sponsor's session changes the sponsor's settings, never the agent's.
    await setPolicy(kohl, 'anyone');
    expect((await openDM(kohl, agent.id)).status).toBe(403);
    const [row] = await db.select().from(actors).where(eq(actors.id, agent.id));
    expect(row.dmPolicy).toBe('nobody');

    // The agent's own token (no scopes needed) allowlists its sponsor.
    const tok = await mint(kohl, agent.id, []);
    const allow = await call(tok, 'POST', '/auth/dm-allowlist', { actorId: kohl.body.id });
    expect(allow.status).toBe(200);
    expect(allow.body.allowlist).toEqual([expect.objectContaining({ id: kohl.body.id })]);
    expect((await openDM(kohl, agent.id)).status).toBe(201);

    // ...and only kohl: someone else is still refused.
    const bob = await createTestUser(app, 'bob');
    expect((await openDM(bob, agent.id)).status).toBe(403);

    // Every change the agent makes is audited for its sponsor.
    const audited = await auditFor(agent.id, 'dm.allowlist.add');
    expect(audited[0]).toMatchObject({ sponsorId: kohl.body.id });
  });

  it('a sponsor can set the starting policy and list, and that choice is recorded', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const agent = await createAgent(kohl, 'robo', {
      dmPolicy: 'friends',
      dmAllowlist: [bob.body.id],
    });
    expect(agent).toMatchObject({ dmPolicy: 'friends', dmPolicySetBy: 'sponsor' });
    const [created] = await auditFor(kohl.body.id, 'agent.create');
    expect(created.details).toMatchObject({
      dmPolicy: 'friends',
      dmPolicySetBy: 'sponsor',
      dmAllowlist: [bob.body.id],
    });
    expect((await openDM(bob, agent.id)).status).toBe(201);

    // Then the agent changes it itself, and the record says so.
    const tok = await mint(kohl, agent.id, []);
    await setPolicy(tok, 'nobody');
    const s = await call(tok, 'GET', '/auth/dm-settings');
    expect(s.body).toMatchObject({ dmPolicy: 'nobody', setBy: 'self' });
    const view = await call(kohl, 'GET', `/agents/${agent.id}`);
    expect(view.body).toMatchObject({ dmPolicy: 'nobody', dmPolicySetBy: 'self' });
  });

  it('an agent needs dms:open to start a DM, and the other side still decides', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const agent = await createAgent(kohl, 'robo');
    const noOpen = await mint(kohl, agent.id, ['dms:read', 'dms:post']);
    expect((await openDM(noOpen, bob.body.id)).status).toBe(403);

    const canOpen = await mint(kohl, agent.id, ['dms:open', 'dms:post']);
    await setPolicy(bob, 'nobody');
    const refused = await openDM(canOpen, bob.body.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(REFUSED_OPEN);
    await setPolicy(bob, 'anyone');
    expect((await openDM(canOpen, bob.body.id)).status).toBe(201);
  });
});

describe('Neutral refusals', () => {
  it('nobody, a block and a declined cooldown all look the same', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    const dave = await createTestUser(app, 'dave');

    await setPolicy(alice, 'nobody');
    const a = await openDM(bob, alice.body.id);

    await call(carol, 'POST', '/blocks', { actorId: bob.body.id });
    const c = await openDM(bob, carol.body.id);

    await setPolicy(dave, 'friends');
    const req = await openDM(bob, dave.body.id);
    await say(bob, req.body.id as string, 'hi?');
    await call(dave, 'POST', `/dms/${req.body.id}/request/decline`);
    const d = await openDM(bob, dave.body.id);

    for (const r of [a, c, d]) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: REFUSED_OPEN });
    }
  });
});

describe('Message requests', () => {
  it("under friends, a stranger's first message is a request; a friend opens directly", async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    await setPolicy(alice, 'friends');
    await befriend(alice, carol);

    const friend = await openDM(carol, alice.body.id);
    expect(friend.status).toBe(201);
    expect(friend.body.request).toBeUndefined();

    const req = await openDM(bob, alice.body.id);
    expect(req.status).toBe(201);
    expect(req.body.request).toEqual({ state: 'pending', incoming: false });
    const dmId = req.body.id as string;
    // Alice hears about it as a request, not a new conversation.
    expect(wsSent).toContainEqual(
      expect.objectContaining({
        to: alice.body.id,
        message: expect.objectContaining({ type: 'dm:request' }),
      }),
    );

    // One message while it waits; the second is refused.
    expect((await say(bob, dmId, 'hello, may I?')).status).toBe(201);
    expect((await say(bob, dmId, 'hello??')).status).toBe(403);

    // Alice: in requests, not in her DM list.
    const list = await call(alice, 'GET', '/dms');
    expect((list.body as unknown as Array<{ id: string }>).map((c) => c.id)).not.toContain(dmId);
    const reqs = await call(alice, 'GET', '/dms/requests');
    expect(reqs.body).toEqual([
      expect.objectContaining({ id: dmId, request: { state: 'pending', incoming: true } }),
    ]);

    const accept = await call(alice, 'POST', `/dms/${dmId}/request/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.request).toEqual({ state: 'accepted', incoming: true });
    expect((await say(bob, dmId, 'thanks!')).status).toBe(201);
    const after = await call(alice, 'GET', '/dms');
    expect((after.body as unknown as Array<{ id: string }>).map((c) => c.id)).toContain(dmId);
  });

  it('under members_of_shared_servers, sharing a server opens directly', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    await setPolicy(alice, 'members_of_shared_servers');

    const s = await call(alice, 'POST', '/servers', { name: 'House' });
    const serverId = s.body.id as string;
    await call(alice, 'PUT', `/servers/${serverId}`, { isPublic: true });
    expect((await call(bob, 'POST', `/servers/${serverId}/join`)).status).toBe(200);

    const shared = await openDM(bob, alice.body.id);
    expect(shared.status).toBe(201);
    expect(shared.body.request).toBeUndefined();
    const stranger = await openDM(carol, alice.body.id);
    expect(stranger.body.request).toEqual({ state: 'pending', incoming: false });
  });

  it('replying to a request accepts it; declining is quiet and has a cooldown', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    await setPolicy(alice, 'friends');

    const fromBob = await openDM(bob, alice.body.id);
    await say(bob, fromBob.body.id as string, 'hi');
    expect((await say(alice, fromBob.body.id as string, 'oh hi')).status).toBe(201);
    expect((await say(bob, fromBob.body.id as string, 'great')).status).toBe(201);

    const fromCarol = await openDM(carol, alice.body.id);
    const dmId = fromCarol.body.id as string;
    await say(carol, dmId, 'buy my thing');
    expect((await call(alice, 'POST', `/dms/${dmId}/request/decline`)).status).toBe(200);

    // Carol isn't told: her view still says pending, and alice still
    // shows as a participant. She just can't send or ask again.
    const carolView = (await call(carol, 'GET', '/dms')).body as unknown as Array<{
      id: string;
      request?: unknown;
      participants: Array<{ id: string }>;
      left?: unknown;
    }>;
    const mine = carolView.find((c) => c.id === dmId)!;
    expect(mine.request).toEqual({ state: 'pending', incoming: false });
    expect(mine.participants.map((p) => p.id)).toContain(alice.body.id);
    expect(mine.left).toBeUndefined();
    expect((await say(carol, dmId, 'hello?')).status).toBe(403);
    expect((await openDM(carol, alice.body.id)).status).toBe(403);

    // Alice no longer has it at all, and gets nothing more from it.
    expect((await call(alice, 'GET', `/dms/${dmId}/messages`)).status).toBe(403);
    expect(wsSent).toContainEqual({
      to: `unsubscribe:${alice.body.id}`,
      message: { channelId: dmId },
    });

    // After the cooldown, carol may ask once more.
    await db
      .update(dmRequests)
      .set({ cooldownUntil: new Date(Date.now() - 1000) })
      .where(eq(dmRequests.fromId, carol.body.id));
    const again = await openDM(carol, alice.body.id);
    expect(again.status).toBe(201);
    expect(again.body.request).toEqual({ state: 'pending', incoming: false });
  });

  it('the allowlist opens directly whatever the policy', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    await setPolicy(alice, 'nobody');
    await call(alice, 'POST', '/auth/dm-allowlist', { actorId: bob.body.id });
    const dm = await openDM(bob, alice.body.id);
    expect(dm.status).toBe(201);
    expect(dm.body.request).toBeUndefined();
    await call(alice, 'DELETE', `/auth/dm-allowlist/${bob.body.id}`);
    const settings = await call(alice, 'GET', '/auth/dm-settings');
    expect(settings.body.allowlist).toEqual([]);
  });
});

describe('Leaving', () => {
  it('a leaver stops receiving it, the others see "left", and nobody can put them back', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const dm = await openDM(alice, bob.body.id);
    const dmId = dm.body.id as string;
    await say(alice, dmId, 'hey');

    wsSent.length = 0;
    expect((await call(bob, 'POST', `/dms/${dmId}/leave`)).status).toBe(200);
    // Live delivery to bob stops, his other tabs drop it, alice is told.
    expect(wsSent).toContainEqual({
      to: `unsubscribe:${bob.body.id}`,
      message: { channelId: dmId },
    });
    expect(wsSent).toContainEqual({
      to: bob.body.id,
      message: { type: 'dm:removed', payload: { dmId } },
    });
    expect(wsSent).toContainEqual(
      expect.objectContaining({
        to: `channel:${dmId}`,
        message: expect.objectContaining({ type: 'dm:left' }),
      }),
    );

    const bobList = (await call(bob, 'GET', '/dms')).body as unknown as unknown[];
    expect(bobList).toHaveLength(0);
    expect((await call(bob, 'GET', `/dms/${dmId}/messages`)).status).toBe(403);
    expect((await call(bob, 'GET', `/channels/${dmId}/messages`)).status).toBe(403);

    const aliceList = (await call(alice, 'GET', '/dms')).body as unknown as Array<{
      left?: Array<{ id: string }>;
      participants: Array<{ id: string }>;
    }>;
    expect(aliceList[0].left?.map((p) => p.id)).toEqual([bob.body.id]);
    expect(aliceList[0].participants.map((p) => p.id)).toEqual([alice.body.id]);

    // Alice can't post to nobody, and can't reopen it with bob.
    expect((await say(alice, dmId, 'come back')).status).toBe(403);
    const reopen = await openDM(alice, bob.body.id);
    expect(reopen.status).toBe(403);
    expect(reopen.body.error).toBe(REFUSED_OPEN);

    // Bob can come back, to the same conversation.
    const back = await openDM(bob, alice.body.id);
    expect(back.status).toBe(200);
    expect(back.body.id).toBe(dmId);
    expect((await say(alice, dmId, 'welcome back')).status).toBe(201);
  });

  it("a sponsor can't force an agent back into a DM it left", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl, 'robo', { dmAllowlist: [] });
    const tok = await mint(kohl, agent.id, []);
    await call(tok, 'POST', '/auth/dm-allowlist', { actorId: kohl.body.id });
    const dm = await openDM(kohl, agent.id);
    const dmId = dm.body.id as string;

    // A token with no scopes at all can leave.
    expect((await call(tok, 'POST', `/dms/${dmId}/leave`)).status).toBe(200);
    expect((await auditFor(agent.id, 'dm.leave'))[0]).toMatchObject({ sponsorId: kohl.body.id });

    // The allowlist still names kohl, but that doesn't override leaving.
    const again = await openDM(kohl, agent.id);
    expect(again.status).toBe(403);
    expect((await say(kohl, dmId, 'get back here')).status).toBe(403);
    // Nor can kohl post through the channel route.
    expect(
      (await call(kohl, 'POST', `/channels/${dmId}/messages`, { content: 'please' })).status,
    ).toBe(403);
    // Nor mint a token scoped to a DM the agent isn't in any more.
    const scoped = await call(kohl, 'POST', `/agents/${agent.id}/tokens`, {
      name: 'sneaky',
      scopes: [`dms:post:${dmId}`],
    });
    expect(scoped.status).toBe(403);
  });

  it('an agent can leave a server with any token, and that drops its grant and join scope', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl, 'robo');
    const s = await call(kohl, 'POST', '/servers', { name: 'House' });
    const serverId = s.body.id as string;
    const tok = await mint(kohl, agent.id, []);
    expect(
      (await call(kohl, 'POST', `/servers/${serverId}/agents`, { agentId: agent.id })).status,
    ).toBe(201);
    const [before] = await db.select().from(agentTokens).where(eq(agentTokens.actorId, agent.id));
    expect(before.scopes).toContain(`servers:join:${serverId}`);

    expect((await call(tok, 'POST', `/servers/${serverId}/leave`)).status).toBe(200);
    const grants = await db
      .select()
      .from(serverAgentGrants)
      .where(eq(serverAgentGrants.agentId, agent.id));
    expect(grants).toHaveLength(0);
    const [after] = await db.select().from(agentTokens).where(eq(agentTokens.actorId, agent.id));
    expect(after.scopes).not.toContain(`servers:join:${serverId}`);
    expect((await call(tok, 'POST', `/servers/${serverId}/join`)).status).toBe(403);
  });

  it('people can leave servers too, and stop getting their channels live', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const s = await call(alice, 'POST', '/servers', { name: 'House' });
    const serverId = s.body.id as string;
    await call(alice, 'PUT', `/servers/${serverId}`, { isPublic: true });
    await call(bob, 'POST', `/servers/${serverId}/join`);
    const channels = (await call(bob, 'GET', `/servers/${serverId}/channels`))
      .body as unknown as Array<{ id: string }>;
    wsSent.length = 0;
    expect((await call(bob, 'POST', `/servers/${serverId}/leave`)).status).toBe(200);
    for (const ch of channels) {
      expect(wsSent).toContainEqual({
        to: `unsubscribe:${bob.body.id}`,
        message: { channelId: ch.id },
      });
    }
    expect((await call(bob, 'GET', `/channels/${channels[0].id}/messages`)).status).toBe(403);
  });
});

describe('Blocking', () => {
  it('a block beats an accepted request', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    await setPolicy(alice, 'friends');
    const req = await openDM(bob, alice.body.id);
    const dmId = req.body.id as string;
    await say(bob, dmId, 'hi');
    await call(alice, 'POST', `/dms/${dmId}/request/accept`);
    expect((await say(bob, dmId, 'accepted!')).status).toBe(201);

    expect((await call(alice, 'POST', '/blocks', { actorId: bob.body.id })).status).toBe(201);
    expect((await say(bob, dmId, 'still there?')).status).toBe(403);
    expect((await openDM(bob, alice.body.id)).status).toBe(200); // the existing DM, read-only
    expect((await say(alice, dmId, 'no')).status).toBe(403); // blocking is both ways for DMs
    // Thread replies are DM posts too.
    const msgs = (await call(bob, 'GET', `/dms/${dmId}/messages`)).body as unknown as {
      messages: Array<{ message: { id: string } }>;
    };
    const reply = await call(
      bob,
      'POST',
      `/channels/${dmId}/messages/${msgs.messages[0].message.id}/replies`,
      { content: 'reply' },
    );
    expect(reply.status).toBe(403);

    const blocks = await call(alice, 'GET', '/blocks');
    expect(blocks.body).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ id: bob.body.id }) }),
    ]);
    expect((await call(alice, 'DELETE', `/blocks/${bob.body.id}`)).status).toBe(200);
    expect((await say(bob, dmId, 'thanks')).status).toBe(201);
  });

  it('a block stops new requests and mentions', async () => {
    const alice = await createTestUser(app, 'alice');
    const bob = await createTestUser(app, 'bob');
    const s = await call(alice, 'POST', '/servers', { name: 'House' });
    const serverId = s.body.id as string;
    await call(alice, 'PUT', `/servers/${serverId}`, { isPublic: true });
    await call(bob, 'POST', `/servers/${serverId}/join`);
    const [ch] = (await call(bob, 'GET', `/servers/${serverId}/channels`))
      .body as unknown as Array<{
      id: string;
    }>;

    await call(bob, 'POST', `/channels/${ch.id}/messages`, { content: '@alice before' });
    await call(alice, 'POST', '/blocks', { actorId: bob.body.id });
    await call(bob, 'POST', `/channels/${ch.id}/messages`, { content: '@alice after' });

    const mentions = await call(alice, 'GET', '/mentions');
    expect((mentions.body as unknown as { messages: unknown[] }).messages).toHaveLength(0);
    expect((await openDM(bob, alice.body.id)).status).toBe(403);
  });

  it("an agent's blocks are audited for its sponsor", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const agent = await createAgent(kohl, 'robo', { dmPolicy: 'anyone' });
    const tok = await mint(kohl, agent.id, []);
    expect((await call(tok, 'POST', '/blocks', { actorId: bob.body.id })).status).toBe(201);
    const [row] = await auditFor(agent.id, 'block.add');
    expect(row).toMatchObject({ sponsorId: kohl.body.id, details: { blockedId: bob.body.id } });
    expect((await openDM(bob, agent.id)).status).toBe(403);
  });
});
