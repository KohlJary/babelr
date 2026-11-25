// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import { createTestApp, cleanDb } from '../helpers.ts';
import { invites } from '../../db/schema/invites.ts';
import nodeinfoRoutes from '../../federation/nodeinfo.ts';
import { parsePublicUrl, parseRegistrationMode, parseTrustProxy } from '../../config.ts';
import type { Config, RegistrationMode } from '../../config.ts';
import type { createDb } from '../../db/index.ts';

type App = import('fastify').FastifyInstance;

const apps: App[] = [];
let db: ReturnType<typeof createDb>;
let openApp: App;
let inviteApp: App;
let closedApp: App;
let tunnelApp: App;
let publicUrlApp: App;
let limitedApp: App;

async function make(opts: Parameters<typeof createTestApp>[0]) {
  const r = await createTestApp(opts);
  apps.push(r.app);
  db = r.db;
  return r.app;
}

beforeAll(async () => {
  openApp = await make({});
  inviteApp = await make({ config: { registration: 'invite' } });
  closedApp = await make({ config: { registration: 'closed' } });
  // cloudflared connects from loopback and says the browser used https.
  tunnelApp = await make({ config: { registration: 'invite' }, trustProxy: 'loopback' });
  publicUrlApp = await make({
    config: { registration: 'invite', publicUrl: 'https://house.example.net' },
  });
  limitedApp = await make({ rateLimit: true, trustProxy: 'loopback' });
});

afterAll(async () => {
  for (const a of apps) await a.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

const PASSWORD = 'test-password-12chars';

function register(app: App, username: string, extra: Record<string, unknown> = {}, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    headers,
    payload: { username, email: `${username}@test.local`, password: PASSWORD, ...extra },
  });
}

/** The owner registers (first person: allowed in every mode), makes a
 *  server and an invite to it. */
async function ownerWithInvite(app: App, invite: { maxUses?: number; expiresInHours?: number }) {
  const owner = await register(app, 'owner');
  expect(owner.statusCode).toBe(201);
  const cookie = (owner.headers['set-cookie'] as string | string[]).toString().split(';')[0];
  const srv = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie },
    payload: { name: 'The House' },
  });
  expect(srv.statusCode).toBe(201);
  const serverId = JSON.parse(srv.body).id as string;
  const inv = await app.inject({
    method: 'POST',
    url: `/servers/${serverId}/invites`,
    headers: { cookie },
    payload: invite,
  });
  expect(inv.statusCode).toBe(201);
  const body = JSON.parse(inv.body) as { code: string; url: string };
  return { cookie, serverId, ownerId: JSON.parse(owner.body).id as string, ...body };
}

async function cookieOf(res: Awaited<ReturnType<typeof register>>) {
  return (res.headers['set-cookie'] as string | string[]).toString().split(';')[0];
}

async function serverIdsOf(app: App, cookie: string) {
  const list = await app.inject({ method: 'GET', url: '/servers', headers: { cookie } });
  return (JSON.parse(list.body) as Array<{ id: string }>).map((s) => s.id);
}

describe('config parsing', () => {
  it('REGISTRATION defaults to open and refuses unknown values', () => {
    expect(parseRegistrationMode(undefined)).toBe('open');
    expect(parseRegistrationMode('')).toBe('open');
    expect(parseRegistrationMode('Invite')).toBe('invite');
    expect(parseRegistrationMode('closed')).toBe('closed');
    expect(() => parseRegistrationMode('invite-only')).toThrow(/REGISTRATION/);
  });

  it('TRUST_PROXY keeps the old default and takes Fastify values', () => {
    expect(parseTrustProxy(undefined, false)).toBe(false);
    expect(parseTrustProxy(undefined, true)).toBe(true);
    expect(parseTrustProxy('true', false)).toBe(true);
    expect(parseTrustProxy('false', true)).toBe(false);
    expect(parseTrustProxy('1', false)).toBe(1);
    expect(parseTrustProxy('loopback', false)).toBe('loopback');
  });

  it('PUBLIC_URL is reduced to an origin', () => {
    expect(parsePublicUrl(undefined)).toBeUndefined();
    expect(parsePublicUrl('https://a-b-c.trycloudflare.com/')).toBe(
      'https://a-b-c.trycloudflare.com',
    );
    expect(() => parsePublicUrl('a-b-c.trycloudflare.com')).toThrow(/PUBLIC_URL/);
    expect(() => parsePublicUrl('ftp://x.example')).toThrow(/PUBLIC_URL/);
  });
});

describe('REGISTRATION=open (default)', () => {
  it('anyone may register, and says so', async () => {
    await register(openApp, 'first');
    expect((await register(openApp, 'stranger')).statusCode).toBe(201);
    const info = await openApp.inject({ method: 'GET', url: '/auth/registration' });
    expect(JSON.parse(info.body)).toEqual({ mode: 'open', inviteRequired: false, closed: false });
  });

  it('an invite given at sign-up joins the new account to its server', async () => {
    const { code, serverId } = await ownerWithInvite(openApp, {});
    const res = await register(openApp, 'cousin', { inviteCode: code });
    expect(res.statusCode).toBe(201);
    expect(await serverIdsOf(openApp, await cookieOf(res))).toContain(serverId);
  });
});

describe('REGISTRATION=invite', () => {
  it('lets the first person in without an invite, then nobody without one', async () => {
    const before = await inviteApp.inject({ method: 'GET', url: '/auth/registration' });
    expect(JSON.parse(before.body)).toMatchObject({ mode: 'invite', inviteRequired: false });
    expect((await register(inviteApp, 'owner')).statusCode).toBe(201);
    const res = await register(inviteApp, 'stranger');
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ inviteRequired: true });
    const info = await inviteApp.inject({ method: 'GET', url: '/auth/registration' });
    expect(JSON.parse(info.body)).toEqual({ mode: 'invite', inviteRequired: true, closed: false });
  });

  it('a valid invite creates the account, joins the server and spends a use', async () => {
    const { code, serverId } = await ownerWithInvite(inviteApp, { maxUses: 2 });
    const res = await register(inviteApp, 'cousin', { inviteCode: code });
    expect(res.statusCode).toBe(201);
    expect(await serverIdsOf(inviteApp, await cookieOf(res))).toContain(serverId);
    const [row] = await db.select().from(invites).where(eq(invites.code, code));
    expect(row.uses).toBe(1);
  });

  it('a single-use invite lets exactly one person in', async () => {
    const { code } = await ownerWithInvite(inviteApp, { maxUses: 1 });
    const results = await Promise.all([
      register(inviteApp, 'cousin_a', { inviteCode: code }),
      register(inviteApp, 'cousin_b', { inviteCode: code }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 410]);
    const later = await register(inviteApp, 'cousin_c', { inviteCode: code });
    expect(later.statusCode).toBe(410);
  });

  it('refuses expired, unknown and malformed invites without creating an account', async () => {
    const { code } = await ownerWithInvite(inviteApp, {});
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.code, code));
    expect((await register(inviteApp, 'late', { inviteCode: code })).statusCode).toBe(410);
    expect((await register(inviteApp, 'guess', { inviteCode: 'deadbeef' })).statusCode).toBe(404);
    expect((await register(inviteApp, 'odd', { inviteCode: "x' OR 1=1" })).statusCode).toBe(404);
    // None of them got an account: the username is still free.
    const { code: fresh } = await (async () => {
      const owner = await inviteApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'owner@test.local', password: PASSWORD },
      });
      const cookie = await cookieOf(owner);
      const [srv] = await serverIdsOf(inviteApp, cookie);
      const inv = await inviteApp.inject({
        method: 'POST',
        url: `/servers/${srv}/invites`,
        headers: { cookie },
        payload: {},
      });
      return JSON.parse(inv.body) as { code: string };
    })();
    expect((await register(inviteApp, 'late', { inviteCode: fresh })).statusCode).toBe(201);
  });

  it('an invite minted by an agent opens no door', async () => {
    const { cookie, serverId, ownerId } = await ownerWithInvite(inviteApp, {});
    const agent = await inviteApp.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { username: 'helper', kind: 'agent', displayName: 'Helper' },
    });
    // Agent accounts made by a sponsor still work in invite mode.
    expect(agent.statusCode).toBe(201);
    const agentId = JSON.parse(agent.body).id as string;
    expect(agentId).not.toBe(ownerId);
    await db.insert(invites).values({ code: 'agentmade', serverId, createdBy: agentId });
    const res = await register(inviteApp, 'cousin', { inviteCode: 'agentmade' });
    expect(res.statusCode).toBe(410);
  });

  it('opening the link again after registering through it is a no-op', async () => {
    const { code, serverId } = await ownerWithInvite(inviteApp, { maxUses: 1 });
    const res = await register(inviteApp, 'cousin', { inviteCode: code });
    const join = await inviteApp.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: { cookie: await cookieOf(res) },
    });
    expect(join.statusCode).toBe(200);
    expect(JSON.parse(join.body).server.id).toBe(serverId);
    const [row] = await db.select().from(invites).where(eq(invites.code, code));
    expect(row.uses).toBe(1);
  });

  it('previews an invite to someone not signed in', async () => {
    const { code } = await ownerWithInvite(inviteApp, { maxUses: 1 });
    const ok = await inviteApp.inject({ method: 'GET', url: `/invites/${code}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ valid: true, server: { name: 'The House' } });
    await register(inviteApp, 'cousin', { inviteCode: code });
    const spent = await inviteApp.inject({ method: 'GET', url: `/invites/${code}` });
    expect(spent.statusCode).toBe(410);
    expect(JSON.parse(spent.body)).toMatchObject({ valid: false });
    const none = await inviteApp.inject({ method: 'GET', url: '/invites/nope1234' });
    expect(none.statusCode).toBe(404);
  });
});

describe('REGISTRATION=closed', () => {
  it('lets only the first person in, invite or not', async () => {
    const { code } = await ownerWithInvite(closedApp, {});
    expect((await register(closedApp, 'stranger')).statusCode).toBe(403);
    expect((await register(closedApp, 'cousin', { inviteCode: code })).statusCode).toBe(403);
    const info = await closedApp.inject({ method: 'GET', url: '/auth/registration' });
    expect(JSON.parse(info.body)).toEqual({ mode: 'closed', inviteRequired: false, closed: true });
  });
});

describe('nodeinfo', () => {
  async function nodeinfo(registration: RegistrationMode) {
    const f = Fastify();
    f.register(
      fp(
        async (x) => {
          x.decorate('db', db);
          x.decorate('config', { domain: 'test.babelr.local', registration } as Config);
        },
        { name: 'db' },
      ),
    );
    await f.register(nodeinfoRoutes);
    const res = await f.inject({ method: 'GET', url: '/nodeinfo/2.1' });
    await f.close();
    return JSON.parse(res.body).openRegistrations as boolean;
  }

  it('advertises open registrations only in open mode', async () => {
    expect(await nodeinfo('open')).toBe(true);
    expect(await nodeinfo('invite')).toBe(false);
    expect(await nodeinfo('closed')).toBe(false);
  });
});

describe('behind an https tunnel', () => {
  const viaTunnel = {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'a-b-c.trycloudflare.com',
    'x-forwarded-for': '203.0.113.7',
  };

  it('marks the session cookie Secure over https, and not over plain localhost', async () => {
    const owner = await register(tunnelApp, 'owner');
    expect(owner.headers['set-cookie']!.toString()).not.toMatch(/;\s*Secure/i);
    const login = await tunnelApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: viaTunnel,
      payload: { email: 'owner@test.local', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const set = login.headers['set-cookie']!.toString();
    expect(set).toMatch(/;\s*Secure/i);
    expect(set).toMatch(/SameSite=Strict/i);
  });

  it('ignores forwarded headers from a peer it does not trust', async () => {
    const res = await register(openApp, 'owner', {}, viaTunnel);
    expect(res.headers['set-cookie']!.toString()).not.toMatch(/;\s*Secure/i);
  });

  it('builds invite links from the origin the owner used', async () => {
    const { cookie, serverId } = await ownerWithInvite(tunnelApp, {});
    const inv = await tunnelApp.inject({
      method: 'POST',
      url: `/servers/${serverId}/invites`,
      headers: { cookie, ...viaTunnel },
      payload: { maxUses: 1 },
    });
    expect(JSON.parse(inv.body).url).toMatch(/^https:\/\/a-b-c\.trycloudflare\.com\/invite\/\w+$/);
  });

  it('PUBLIC_URL wins for invite links, even when made from localhost', async () => {
    const { url } = await ownerWithInvite(publicUrlApp, {});
    expect(url).toMatch(/^https:\/\/house\.example\.net\/invite\/\w+$/);
    const { url: local } = await (async () => {
      await cleanDb(db);
      return ownerWithInvite(openApp, {});
    })();
    // Unset, it's the old http://BABELR_DOMAIN link.
    expect(local).toMatch(/^http:\/\/test\.babelr\.local\/invite\/\w+$/);
  });
});

describe('rate limits on the doors', () => {
  const from = (ip: string) => ({ 'x-forwarded-for': ip });
  const login = (ip: string) =>
    limitedApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: from(ip),
      payload: { email: 'nobody@test.local', password: 'wrong-password-123' },
    });

  it('limits login guesses per visitor, not for everyone behind the tunnel', async () => {
    for (let i = 0; i < 10; i++) expect((await login('198.51.100.1')).statusCode).toBe(401);
    expect((await login('198.51.100.1')).statusCode).toBe(429);
    // Another visitor, through the same proxy, has their own bucket.
    expect((await login('198.51.100.2')).statusCode).toBe(401);
  });

  it('limits sign-ups per visitor', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await register(limitedApp, `u${i}xx`, {}, from('198.51.100.9'))).statusCode).toBe(
        201,
      );
    }
    expect((await register(limitedApp, 'onemore', {}, from('198.51.100.9'))).statusCode).toBe(429);
  });

  it('limits anonymous invite lookups', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (
        await limitedApp.inject({
          method: 'GET',
          url: `/invites/code${i}`,
          headers: from('198.51.100.3'),
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});
