// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Fastify from 'fastify';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import type { createDb } from '../db/index.ts';
import {
  AGENT_SCOPES,
  ROUTE_SCOPES,
  checkScopes,
  isValidScope,
  ruleForRoute,
} from '../agent-scopes.ts';
import { isActorLike } from '../actor-kind.ts';

const CH = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('agent scope map', () => {
  it('denies an unmapped route even with every scope', () => {
    const d = checkScopes('DELETE', '/servers/:serverId', { serverId: CH }, [...AGENT_SCOPES]);
    expect(d).toMatchObject({ allowed: false, reason: 'route_not_mapped' });
    expect(checkScopes('GET', undefined, {}, [...AGENT_SCOPES]).allowed).toBe(false);
  });

  it('requires the mapped scope', () => {
    const url = '/channels/:channelId/messages';
    expect(checkScopes('POST', url, { channelId: CH }, ['channels:read']).allowed).toBe(false);
    expect(checkScopes('POST', url, { channelId: CH }, ['channels:post']).allowed).toBe(true);
    expect(checkScopes('GET', url, { channelId: CH }, ['channels:read']).allowed).toBe(true);
  });

  it('treats HEAD as GET', () => {
    expect(ruleForRoute('HEAD', '/channels/:channelId/messages')?.scope).toBe('channels:read');
  });

  it('matches a narrowed scope only against its own resource', () => {
    const url = '/channels/:channelId/messages';
    const scopes = [`channels:post:${CH}`];
    expect(checkScopes('POST', url, { channelId: CH }, scopes)).toMatchObject({
      allowed: true,
      grantedBy: `channels:post:${CH}`,
    });
    expect(checkScopes('POST', url, { channelId: OTHER }, scopes).allowed).toBe(false);
    // A narrowed scope never grants a route without that param.
    expect(checkScopes('GET', '/servers', {}, [`channels:read:${CH}`]).allowed).toBe(false);
  });

  it('maps plugin routes by prefix: GET reads, everything else writes', () => {
    expect(ruleForRoute('GET', '/plugins/polls/polls/:slug')?.scope).toBe('plugins:read');
    expect(ruleForRoute('POST', '/plugins/polls/polls/:slug/vote')?.scope).toBe('plugins:write');
    expect(ruleForRoute('PATCH', '/plugins/project-management/work-items/:slug')?.scope).toBe(
      'plugins:write',
    );
  });

  it('never maps admin, account, token or socket routes', () => {
    for (const key of [
      'POST /agents',
      'POST /agents/:agentId/tokens',
      'POST /agents/:agentId/suspend',
      'GET /servers/:serverId/audit-log',
      'PUT /servers/:serverId',
      'POST /servers/:serverId/roles',
      'PUT /auth/profile',
      'PUT /auth/password',
      'POST /auth/login',
      'POST /dms',
      'GET /ws',
      'POST /upload',
    ]) {
      const [m, u] = key.split(' ');
      expect(ruleForRoute(m, u), key).toBeNull();
    }
  });

  it('validates mintable scopes', () => {
    expect(isValidScope('channels:read')).toBe(true);
    expect(isValidScope(`dms:post:${CH}`)).toBe(true);
    expect(isValidScope(`servers:join:${CH}`)).toBe(true);
    expect(isValidScope('admin')).toBe(false);
    expect(isValidScope(`plugins:write:${CH}`)).toBe(false);
    expect(isValidScope('channels:read:general')).toBe(false);
    expect(isValidScope(42)).toBe(false);
  });

  it('isActorLike accepts Person and Service, not Group', () => {
    expect(isActorLike('Person')).toBe(true);
    expect(isActorLike('Service')).toBe(true);
    expect(isActorLike('Group')).toBe(false);
    expect(isActorLike(undefined)).toBe(false);
  });
});

describe('every mounted route, walked with an all-scopes token', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof createDb>;
  let routes: Array<{ method: string; url: string }>;

  beforeAll(async () => {
    const r = await createTestApp({ plugins: true, actorProfiles: true });
    app = r.app;
    db = r.db;
    routes = r.routes;
    await cleanDb(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const fill = (url: string) =>
    url.replace(/:(\w+)/g, (_m, name: string) =>
      name.toLowerCase().includes('slug') || name === 'code' || name === 'username'
        ? 'x'
        : '33333333-3333-3333-3333-333333333333',
    );

  it('an unmapped route gives a token 403 before the route runs; a mapped one is let through', async () => {
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
      payload: { name: 'walk', scopes: [...AGENT_SCOPES] },
    });
    const token = JSON.parse(t.body).token as string;

    const seen = new Set<string>();
    let unmapped = 0;
    let mapped = 0;
    for (const r of routes) {
      // HEAD has no body to read; it maps exactly as GET (tested above).
      if (r.method === 'OPTIONS' || r.method === 'HEAD' || r.url === '*') continue;
      const key = `${r.method} ${r.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const res = await app.inject({
        method: r.method as 'GET',
        url: fill(r.url),
        headers: { authorization: `Bearer ${token}` },
        payload: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined,
      });
      if (ruleForRoute(r.method, r.url)) {
        mapped += 1;
        // Let through by the hook; the route itself answers (it may
        // still refuse: not a member, not found, bad input).
        expect(res.statusCode, key).not.toBe(401);
        if (res.statusCode === 403) {
          expect(JSON.parse(res.body).error, key).not.toBe('Token scope does not allow this');
        }
      } else {
        unmapped += 1;
        expect(res.statusCode, key).toBe(403);
        expect(JSON.parse(res.body).error, key).toBe('Token scope does not allow this');
      }
    }
    expect(unmapped).toBeGreaterThan(50);
    expect(mapped).toBeGreaterThan(15);
    // Every exact entry in the map names a route that exists.
    for (const key of Object.keys(ROUTE_SCOPES)) {
      expect(seen.has(key), key).toBe(true);
    }
  });
});
