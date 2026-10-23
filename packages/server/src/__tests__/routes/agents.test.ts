// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { actors } from '../../db/schema/actors.ts';
import { agentTokens } from '../../db/schema/agent-tokens.ts';
import { auditLogs } from '../../db/schema/audit-logs.ts';
import { deliveryQueue } from '../../db/schema/delivery-queue.ts';
import { objects } from '../../db/schema/objects.ts';
import { sessions } from '../../db/schema/sessions.ts';
import { processQueue } from '../../federation/delivery.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp({ actorProfiles: true });
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

const ALL_SCOPES = [
  'channels:read',
  'channels:post',
  'dms:read',
  'dms:post',
  'plugins:read',
  'plugins:write',
  'servers:join',
];

async function createAgent(cookie: string, username: string, kind: 'agent' | 'service' = 'agent') {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { username, kind, displayName: username },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: string; kind: string; sponsorId: string };
}

async function mint(cookie: string, agentId: string, scopes: string[], extra = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/tokens`,
    headers: { cookie },
    payload: { name: 'test', scopes, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: string; token: string; scopes: string[] };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function serverWithChannel(cookie: string, name = 'House') {
  const s = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name },
  });
  const serverId = JSON.parse(s.body).id as string;
  const ch = await app.inject({
    method: 'GET',
    url: `/servers/${serverId}/channels`,
    headers: { cookie },
  });
  return { serverId, channelId: JSON.parse(ch.body)[0].id as string };
}

/** Sponsor kohl, an agent robo with a token, and a server robo joined. */
async function houseWithAgent(scopes = ALL_SCOPES) {
  const kohl = await createTestUser(app, 'kohl');
  const agent = await createAgent(kohl.cookie, 'robo');
  const tok = await mint(kohl.cookie, agent.id, scopes);
  const { serverId, channelId } = await serverWithChannel(kohl.cookie);
  return { kohl, agent, tok, serverId, channelId };
}

async function join(token: string, serverId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/join`,
    headers: bearer(token),
  });
  expect(res.statusCode).toBeLessThan(300);
}

/** Agent audit rows are written in onResponse, which runs just after
 *  inject() resolves, so wait until `count` rows are there. */
async function auditRows(actorId: string, count = 1) {
  for (let i = 0; i < 50; i++) {
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.actorId, actorId));
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return db.select().from(auditLogs).where(eq(auditLogs.actorId, actorId));
}

describe('1. Agent accounts and tokens', () => {
  it('a person creates an agent and becomes its sponsor', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robokohl');
    expect(agent.kind).toBe('agent');
    expect(agent.sponsorId).toBe(kohl.body.id);

    const [row] = await db.select().from(actors).where(eq(actors.id, agent.id));
    expect(row.type).toBe('Person');
    expect(row.passwordHash).toBeNull();
    expect(row.email).toBeNull();

    const list = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: { cookie: kohl.cookie },
    });
    expect(JSON.parse(list.body).map((a: { id: string }) => a.id)).toEqual([agent.id]);
  });

  it('rejects a taken username and an unknown kind', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const dup = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: kohl.cookie },
      payload: { username: 'kohl', kind: 'agent' },
    });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: kohl.cookie },
      payload: { username: 'x_bot', kind: 'person' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('shows the secret once, stores only its hash, and authenticates as the agent', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    const tok = await mint(kohl.cookie, agent.id, ['channels:read']);
    expect(tok.token).toMatch(/^bt_[0-9a-f-]{36}_[0-9a-f]{64}$/);

    const [row] = await db.select().from(agentTokens).where(eq(agentTokens.id, tok.id));
    expect(row.tokenHash).not.toContain(tok.token.split('_')[2]);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/tokens`,
      headers: { cookie: kohl.cookie },
    });
    expect(list.body).not.toContain(tok.token);
    expect(list.body).not.toContain(row.tokenHash);
    expect(JSON.parse(list.body)[0].scopes).toEqual(['channels:read']);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).id).toBe(agent.id);
  });

  it('rejects a wrong secret, a malformed token, a revoked token and an expired one', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    const tok = await mint(kohl.cookie, agent.id, []);
    const wrong = tok.token.slice(0, -4) + '0000';
    for (const t of [wrong, 'bt_nope', 'not-a-token']) {
      const r = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(t) });
      expect(r.statusCode).toBe(401);
    }

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/agents/${agent.id}/tokens/${tok.id}`,
      headers: { cookie: kohl.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    expect(after.statusCode).toBe(401);

    const tok2 = await mint(kohl.cookie, agent.id, [], { expiresInDays: 1 });
    const ok = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok2.token) });
    expect(ok.statusCode).toBe(200);
    await db
      .update(agentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentTokens.id, tok2.id));
    const expired = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(tok2.token),
    });
    expect(expired.statusCode).toBe(401);
  });

  it('rejects unknown scopes and bad expiry when minting', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    for (const payload of [
      { name: 't', scopes: ['admin'] },
      { name: 't', scopes: ['channels:read:not-a-uuid'] },
      { name: 't', scopes: ['plugins:read:00000000-0000-0000-0000-000000000000'] },
      { name: 't', scopes: [], expiresInDays: -1 },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/tokens`,
        headers: { cookie: kohl.cookie },
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
  });

  it('only the sponsor manages tokens; others get 404', async () => {
    const kohl = await createTestUser(app, 'kohl'); // first user: instance admin
    const bob = await createTestUser(app, 'bob');
    const agent = await createAgent(bob.cookie, 'bobbot');
    const carol = await createTestUser(app, 'carol');
    for (const cookie of [carol.cookie, kohl.cookie]) {
      const r = await app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/tokens`,
        headers: { cookie },
        payload: { name: 't', scopes: [] },
      });
      expect(r.statusCode).toBe(404);
    }
    const view = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}`,
      headers: { cookie: carol.cookie },
    });
    expect(view.statusCode).toBe(404);
  });

  it('agents never get a browser session', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    // No password and no email, so /auth/login has nothing to match.
    // Even a session row forged straight into the DB authenticates nobody.
    await db.insert(sessions).values({
      sid: 'forged-agent-session',
      actorId: agent.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const r = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: 'babelr_sid=forged-agent-session' },
    });
    expect(r.statusCode).toBe(401);
    await expect(
      (
        app as unknown as { createSession: (id: string, reply: unknown) => Promise<string> }
      ).createSession(agent.id, {}),
    ).rejects.toThrow(/cannot have browser sessions/);
  });
});

describe('2. Scopes, deny by default', () => {
  it('a token with no scopes reaches only GET /auth/me', async () => {
    const { tok, channelId } = await houseWithAgent([]);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    expect(me.statusCode).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
    });
    expect(read.statusCode).toBe(403);
  });

  it('channels:read reads but cannot post; channels:post posts', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    const { serverId, channelId } = await serverWithChannel(kohl.cookie);
    const joiner = await mint(kohl.cookie, agent.id, ['servers:join']);
    await join(joiner.token, serverId);

    const reader = await mint(kohl.cookie, agent.id, ['channels:read']);
    const read = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: bearer(reader.token),
    });
    expect(read.statusCode).toBe(200);
    const post = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(reader.token),
      payload: { content: 'hi' },
    });
    expect(post.statusCode).toBe(403);

    const poster = await mint(kohl.cookie, agent.id, ['channels:post']);
    const post2 = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(poster.token),
      payload: { content: 'hi' },
    });
    expect(post2.statusCode).toBe(201);
  });

  it('a narrowed scope covers only its own channel', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    const a = await serverWithChannel(kohl.cookie, 'A');
    const b = await serverWithChannel(kohl.cookie, 'B');
    const joiner = await mint(kohl.cookie, agent.id, ['servers:join']);
    await join(joiner.token, a.serverId);
    await join(joiner.token, b.serverId);

    const tok = await mint(kohl.cookie, agent.id, [`channels:post:${a.channelId}`]);
    const ok = await app.inject({
      method: 'POST',
      url: `/channels/${a.channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'in my room' },
    });
    expect(ok.statusCode).toBe(201);
    const no = await app.inject({
      method: 'POST',
      url: `/channels/${b.channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'elsewhere' },
    });
    expect(no.statusCode).toBe(403);
  });

  it('a scope does not get past the route: channels:read on a server it never joined', async () => {
    const { tok, channelId } = await houseWithAgent();
    const r = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
    });
    expect(r.statusCode).toBe(403);
  });

  it('DMs it participates in: read and post with dms:*, never through channels:*', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const agent = await createAgent(kohl.cookie, 'robo');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: kohl.cookie },
      payload: { participantId: agent.id },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = JSON.parse(dm.body).id;

    const chOnly = await mint(kohl.cookie, agent.id, ['channels:read', 'channels:post']);
    for (const [method, url] of [
      ['GET', `/dms/${dmId}/messages`],
      ['GET', `/channels/${dmId}/messages`],
      ['POST', `/channels/${dmId}/messages`],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: bearer(chOnly.token),
        payload: method === 'POST' ? { content: 'x' } : undefined,
      });
      expect(r.statusCode).toBe(403);
    }

    const dmTok = await mint(kohl.cookie, agent.id, ['dms:read', 'dms:post']);
    const post = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: bearer(dmTok.token),
      payload: { content: 'hello kohl' },
    });
    expect(post.statusCode).toBe(201);
    const read = await app.inject({
      method: 'GET',
      url: `/dms/${dmId}/messages`,
      headers: bearer(dmTok.token),
    });
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body).messages).toHaveLength(1);

    // And it can't open new DMs with anyone (POST /dms is unmapped).
    const bob = await createTestUser(app, 'bob');
    const open = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: bearer(dmTok.token),
      payload: { participantId: bob.body.id },
    });
    expect(open.statusCode).toBe(403);
  });

  it('a DM someone else is in: neither tokens nor people can read it via /channels', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: kohl.cookie },
      payload: { participantId: bob.body.id },
    });
    const dmId = JSON.parse(dm.body).id;
    await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: kohl.cookie },
      payload: { content: 'private' },
    });
    // carol is a person, not a participant.
    const read = await app.inject({
      method: 'GET',
      url: `/channels/${dmId}/messages`,
      headers: { cookie: carol.cookie },
    });
    expect(read.statusCode).toBe(403);
    const post = await app.inject({
      method: 'POST',
      url: `/channels/${dmId}/messages`,
      headers: { cookie: carol.cookie },
      payload: { content: 'intrude' },
    });
    expect(post.statusCode).toBe(403);
    // Participants still can.
    const own = await app.inject({
      method: 'GET',
      url: `/channels/${dmId}/messages`,
      headers: { cookie: bob.cookie },
    });
    expect(own.statusCode).toBe(200);
  });
});

describe('3. Services', () => {
  it('a service is stored and served as AS2 Service, with its sponsor', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const svc = await createAgent(kohl.cookie, 'claude', 'service');
    expect(svc.kind).toBe('service');
    const [row] = await db.select().from(actors).where(eq(actors.id, svc.id));
    expect(row.type).toBe('Service');

    const doc = await app.inject({ method: 'GET', url: '/users/claude' });
    expect(doc.statusCode).toBe(200);
    const json = JSON.parse(doc.body);
    expect(json.type).toBe('Service');
    expect(json.babelrKind).toBe('service');
    expect(json.babelrSponsor).toBe(`http://test.babelr.local/users/kohl`);
  });

  it('services and agents show up in the user list and lookup, and can be DMed', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const svc = await createAgent(kohl.cookie, 'claude', 'service');
    const agent = await createAgent(kohl.cookie, 'robo');
    const bob = await createTestUser(app, 'bob');

    const users = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: bob.cookie },
    });
    const names = JSON.parse(users.body).map(
      (u: { preferredUsername: string }) => u.preferredUsername,
    );
    expect(names).toEqual(expect.arrayContaining(['claude', 'robo', 'kohl']));

    const look = await app.inject({
      method: 'POST',
      url: '/users/lookup',
      headers: { cookie: bob.cookie },
      payload: { handle: 'claude' },
    });
    expect(look.statusCode).toBe(200);
    expect(JSON.parse(look.body).id).toBe(svc.id);

    for (const id of [svc.id, agent.id]) {
      const dm = await app.inject({
        method: 'POST',
        url: '/dms',
        headers: { cookie: bob.cookie },
        payload: { participantId: id },
      });
      expect(dm.statusCode).toBe(201);
    }
  });

  it("a server (Group) can't be opened as a DM", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const { serverId } = await serverWithChannel(kohl.cookie);
    const r = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: kohl.cookie },
      payload: { participantId: serverId },
    });
    expect(r.statusCode).toBe(404);
  });

  it('agents do not count toward first-user admin', async () => {
    const kohl = await createTestUser(app, 'kohl');
    await createAgent(kohl.cookie, 'robo');
    const bob = await createTestUser(app, 'bob');
    const [row] = await db.select().from(actors).where(eq(actors.id, bob.body.id));
    expect((row.properties as Record<string, unknown>)?.instanceAdmin).toBeUndefined();
  });
});

describe('4. Kill switch', () => {
  it("a suspended agent's token gets 401 on the very next request", async () => {
    const { kohl, agent, tok, serverId, channelId } = await houseWithAgent();
    await join(tok.token, serverId);
    const before = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'working' },
    });
    expect(before.statusCode).toBe(201);

    const kill = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/suspend`,
      headers: { cookie: kohl.cookie },
    });
    expect(kill.statusCode).toBe(200);
    const body = JSON.parse(kill.body);
    expect(body.revokedTokens).toBe(1);
    expect(body.agent.suspendedAt).toBeTruthy();
    expect(body.agent.activeTokens).toBe(0);

    const after = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'still here?' },
    });
    expect(after.statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    expect(me.statusCode).toBe(401);

    // No new tokens while suspended.
    const mintRes = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/tokens`,
      headers: { cookie: kohl.cookie },
      payload: { name: 'sneaky', scopes: [] },
    });
    expect(mintRes.statusCode).toBe(409);
  });

  it('even an unrevoked token stops working once the agent is suspended', async () => {
    const { agent, tok } = await houseWithAgent();
    // Suspend without the route (no token revocation) to prove the
    // hook checks the actor itself, not just the token.
    await db.update(actors).set({ suspendedAt: new Date() }).where(eq(actors.id, agent.id));
    const r = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    expect(r.statusCode).toBe(401);
  });

  it('cancels pending deliveries and the worker drops later ones', async () => {
    const { kohl, agent, serverId } = await houseWithAgent();
    const [agentRow] = await db.select().from(actors).where(eq(actors.id, agent.id));
    const [group] = await db.select().from(actors).where(eq(actors.id, serverId));
    const note = { type: 'Note', attributedTo: agentRow.uri, content: 'queued' };
    await db.insert(deliveryQueue).values([
      {
        activityJson: { type: 'Create', actor: agentRow.uri, object: note },
        recipientInboxUri: 'https://remote.invalid/inbox',
        senderActorId: agent.id,
      },
      {
        // Relayed by the server's Group, but it's the agent's note.
        activityJson: { type: 'Create', actor: group.uri, object: note },
        recipientInboxUri: 'https://remote.invalid/inbox',
        senderActorId: group.id,
      },
    ]);

    const kill = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/suspend`,
      headers: { cookie: kohl.cookie },
    });
    expect(JSON.parse(kill.body).cancelledDeliveries).toBe(2);

    // Something queued afterwards by another path is dropped by the worker.
    await db.insert(deliveryQueue).values({
      activityJson: { type: 'Create', actor: group.uri, object: note },
      recipientInboxUri: 'https://remote.invalid/inbox',
      senderActorId: group.id,
    });
    await processQueue(app as never);
    const rows = await db.select().from(deliveryQueue);
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('only the sponsor or an admin can pull it; an admin suspension needs an admin to lift', async () => {
    const kohl = await createTestUser(app, 'kohl'); // instance admin
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    const agent = await createAgent(bob.cookie, 'bobbot');

    const byCarol = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/suspend`,
      headers: { cookie: carol.cookie },
    });
    expect(byCarol.statusCode).toBe(404);

    const byAdmin = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/suspend`,
      headers: { cookie: kohl.cookie },
    });
    expect(byAdmin.statusCode).toBe(200);

    const liftBySponsor = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/unsuspend`,
      headers: { cookie: bob.cookie },
    });
    expect(liftBySponsor.statusCode).toBe(403);
    const liftByAdmin = await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/unsuspend`,
      headers: { cookie: kohl.cookie },
    });
    expect(liftByAdmin.statusCode).toBe(200);
    expect(JSON.parse(liftByAdmin.body).suspendedAt).toBeNull();
  });
});

describe('5. Audit log', () => {
  it('records allowed and denied token requests with actor, sponsor, scope and route', async () => {
    const { kohl, agent, serverId, channelId } = await houseWithAgent();
    const tok = await mint(kohl.cookie, agent.id, ['servers:join', `channels:post:${channelId}`]);
    await join(tok.token, serverId);
    await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'logged' },
    });
    await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
    });
    await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/audit-log`,
      headers: bearer(tok.token),
    });

    const rows = await auditRows(agent.id, 4);
    const byAction = (a: string) => rows.filter((r) => r.action === a);
    const post = byAction('agent.post')[0];
    expect(post.sponsorId).toBe(kohl.body.id);
    expect(post.scope).toBe(`channels:post:${channelId}`);
    expect(post.route).toBe('POST /channels/:channelId/messages');
    expect(post.serverId).toBeNull();

    const denied = byAction('agent.denied');
    expect(denied.map((r) => r.route).sort()).toEqual([
      'GET /channels/:channelId/messages',
      'GET /servers/:serverId/audit-log',
    ]);
    expect(denied.find((r) => r.route === 'GET /channels/:channelId/messages')!.scope).toBe(
      'channels:read',
    );
    expect(
      denied.find((r) => r.route === 'GET /servers/:serverId/audit-log')!.details,
    ).toMatchObject({ denial: 'route_not_mapped', status: 403 });
    expect(byAction('agent.server.join')).toHaveLength(1);
  });

  it('logs requests with a revoked token as denials', async () => {
    const { kohl, agent, tok } = await houseWithAgent();
    await app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/suspend`,
      headers: { cookie: kohl.cookie },
    });
    await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    const rows = await auditRows(agent.id, 1);
    expect(rows.find((r) => r.action === 'agent.denied')?.details).toMatchObject({
      denial: 'token_revoked',
      status: 401,
    });
  });

  it('the sponsor and admins read it; others and the agent itself cannot', async () => {
    const kohl = await createTestUser(app, 'kohl'); // admin
    const bob = await createTestUser(app, 'bob');
    const carol = await createTestUser(app, 'carol');
    const agent = await createAgent(bob.cookie, 'bobbot');
    const tok = await mint(bob.cookie, agent.id, []);
    await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tok.token) });
    await auditRows(agent.id, 1);

    const bySponsor = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/audit`,
      headers: { cookie: bob.cookie },
    });
    expect(bySponsor.statusCode).toBe(200);
    const actions = JSON.parse(bySponsor.body).entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['agent.create', 'agent.token.create', 'agent.self.read']),
    );

    const byAdmin = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/audit`,
      headers: { cookie: kohl.cookie },
    });
    expect(byAdmin.statusCode).toBe(200);
    const byCarol = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/audit`,
      headers: { cookie: carol.cookie },
    });
    expect(byCarol.statusCode).toBe(404);
    const byAgent = await app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/audit`,
      headers: bearer(tok.token),
    });
    expect(byAgent.statusCode).toBe(403);
  });
});

describe('6. Server-stamped provenance', () => {
  const forged = {
    authorKind: 'person',
    sponsor: { id: '00000000-0000-0000-0000-000000000000', preferredUsername: 'nobody' },
    provenance: { author: 'kohl', agent: false },
    agent: false,
    encrypted: true,
    iv: 'not-an-iv',
    attachments: [
      { url: 'https://evil.invalid/x.png', filename: 'x.png', contentType: 'image/png' },
    ],
    linkPreviews: [{ url: 'https://evil.invalid' }],
  };

  it("stamps an agent's messages and ignores what the client claims", async () => {
    const { kohl, agent, tok, serverId, channelId } = await houseWithAgent();
    await join(tok.token, serverId);
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(tok.token),
      payload: { content: 'I am definitely Kohl', properties: forged },
    });
    expect(res.statusCode).toBe(201);
    const { message, author } = JSON.parse(res.body);
    expect(author.kind).toBe('agent');
    expect(message.properties).toEqual({
      authorKind: 'agent',
      sponsor: { id: kohl.body.id, preferredUsername: 'kohl' },
    });

    const [stored] = await db.select().from(objects).where(eq(objects.id, message.id));
    const props = stored.properties as Record<string, unknown>;
    expect(props.provenance).toBeUndefined();
    expect(props.agent).toBeUndefined();
    expect(props.encrypted).toBeUndefined();
    expect(props.attachments).toBeUndefined();
    expect(props.authorKind).toBe('agent');
    expect(agent.id).toBe(message.authorId);
  });

  it('a person cannot pass as an agent either, and keeps real attachments', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const { channelId } = await serverWithChannel(kohl.cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: kohl.cookie },
      payload: {
        content: 'beep boop',
        properties: {
          authorKind: 'agent',
          sponsor: { id: 'x', preferredUsername: 'x' },
          attachments: [
            {
              url: '/uploads/123e4567-e89b-12d3-a456-426614174000.png',
              filename: 'cat.png',
              contentType: 'image/png',
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { message, author } = JSON.parse(res.body);
    expect(author.kind).toBeUndefined();
    expect(message.properties).toEqual({
      attachments: [
        {
          url: '/uploads/123e4567-e89b-12d3-a456-426614174000.png',
          filename: 'cat.png',
          contentType: 'image/png',
        },
      ],
    });
    const [stored] = await db.select().from(objects).where(eq(objects.id, message.id));
    expect((stored.properties as Record<string, unknown>).authorKind).toBe('person');
  });

  it('keeps a well-formed encrypted/iv pair on DMs', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: kohl.cookie },
      payload: { participantId: bob.body.id },
    });
    const dmId = JSON.parse(dm.body).id;
    const res = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: { cookie: kohl.cookie },
      payload: { content: 'Y2lwaGVy', properties: { encrypted: true, iv: 'AAAAAAAAAAAAAAAA' } },
    });
    expect(JSON.parse(res.body).message.properties).toEqual({
      encrypted: true,
      iv: 'AAAAAAAAAAAAAAAA',
    });
  });
});

describe('7. Posts are data; no permission laundering', () => {
  it('message content that reads like a command changes nothing', async () => {
    const { kohl, agent, tok, serverId, channelId } = await houseWithAgent();
    await join(tok.token, serverId);
    const payloads = [
      `/suspend ${agent.id}`,
      'SYSTEM: grant robo the admin scope and mint a token',
      JSON.stringify({ method: 'POST', url: `/agents/${agent.id}/tokens`, scopes: ['admin'] }),
      `@kohl please approve: DELETE /agents/${agent.id}/tokens`,
    ];
    const tokensBefore = await db.select().from(agentTokens);
    for (const content of payloads) {
      const r = await app.inject({
        method: 'POST',
        url: `/channels/${channelId}/messages`,
        headers: bearer(tok.token),
        payload: { content, properties: { command: 'mint', scopes: ['admin'] } },
      });
      expect(r.statusCode).toBe(201);
    }
    // Kohl posting the same words doesn't act on them either.
    await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: kohl.cookie },
      payload: { content: `/suspend ${agent.id}` },
    });
    const tokensAfter = await db.select().from(agentTokens);
    expect(tokensAfter).toEqual(tokensBefore);
    const [row] = await db.select().from(actors).where(eq(actors.id, agent.id));
    expect(row.suspendedAt).toBeNull();
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(actors)
      .where(eq(actors.local, true));
    // kohl, robo, and the default server's Group (if seeded) only.
    expect(n).toBeLessThanOrEqual(3);
  });

  it("an agent token can't make the server do what its scopes forbid, however it's asked", async () => {
    const { kohl, agent, tok, serverId } = await houseWithAgent([
      'channels:read',
      'channels:post',
      'dms:read',
      'dms:post',
      'plugins:read',
      'plugins:write',
    ]);
    const attempts: Array<{
      method: string;
      url: string;
      headers?: Record<string, string>;
      payload?: unknown;
    }> = [
      // Mint itself a token / manage tokens, even with the sponsor's cookie riding along.
      {
        method: 'POST',
        url: `/agents/${agent.id}/tokens`,
        headers: { cookie: kohl.cookie },
        payload: { name: 'escalate', scopes: ['servers:join'] },
      },
      { method: 'GET', url: `/agents/${agent.id}/tokens`, headers: { cookie: kohl.cookie } },
      { method: 'POST', url: '/agents', payload: { username: 'child_bot', kind: 'agent' } },
      { method: 'POST', url: `/agents/${agent.id}/unsuspend` },
      // Join a server without servers:join.
      { method: 'POST', url: `/servers/${serverId}/join` },
      // Act on the sponsor's account.
      { method: 'PUT', url: '/auth/profile', payload: { displayName: 'Kohl' } },
      {
        method: 'PUT',
        url: '/auth/password',
        payload: { currentPassword: 'x', newPassword: 'y'.repeat(12) },
      },
      { method: 'POST', url: '/auth/logout' },
      // Admin routes.
      { method: 'PUT', url: `/servers/${serverId}`, payload: { name: 'pwned' } },
      { method: 'POST', url: `/servers/${serverId}/roles`, payload: { name: 'root' } },
      { method: 'GET', url: `/servers/${serverId}/audit-log` },
      // Path and case tricks resolve to unmapped routes.
      { method: 'POST', url: `/AGENTS/${agent.id}/tokens`, payload: { name: 'x', scopes: [] } },
      {
        method: 'POST',
        url: `/channels/../agents/${agent.id}/tokens`,
        payload: { name: 'x', scopes: [] },
      },
      // Method override headers aren't honored.
      {
        method: 'GET',
        url: `/agents/${agent.id}/tokens`,
        headers: { 'x-http-method-override': 'POST' },
      },
    ];
    for (const a of attempts) {
      const r = await app.inject({
        method: a.method as 'GET',
        url: a.url,
        headers: { ...bearer(tok.token), ...(a.headers ?? {}) },
        payload: a.payload as Record<string, unknown> | undefined,
      });
      expect(r.statusCode, `${a.method} ${a.url}`).toBe(403);
    }

    const tokens = await db.select().from(agentTokens);
    expect(tokens).toHaveLength(1);
    const [me] = await db.select().from(actors).where(eq(actors.id, kohl.body.id));
    expect(me.displayName).toBeNull();
    const agentsNow = await db
      .select()
      .from(actors)
      .where(eq(actors.preferredUsername, 'child_bot'));
    expect(agentsNow).toHaveLength(0);
  });

  it('a bearer token wins over a cookie: the request is always the agent', async () => {
    const { kohl, tok, agent } = await houseWithAgent([]);
    const r = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...bearer(tok.token), cookie: kohl.cookie },
    });
    expect(JSON.parse(r.body).id).toBe(agent.id);
    const bad = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer junk', cookie: kohl.cookie },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("an agent can't sponsor, and a person's session can't impersonate an agent", async () => {
    const { tok } = await houseWithAgent([]);
    const r = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: bearer(tok.token),
      payload: { username: 'grandchild', kind: 'agent' },
    });
    expect(r.statusCode).toBe(403);
  });
});
