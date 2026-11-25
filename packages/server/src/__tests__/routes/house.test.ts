// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import type { HouseView } from '@babelr/shared';

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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function agentWithToken(cookie: string, username: string, scopes: string[]) {
  const a = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { username, kind: 'agent', displayName: username },
  });
  expect(a.statusCode).toBe(201);
  const agent = JSON.parse(a.body) as { id: string };
  const t = await app.inject({
    method: 'POST',
    url: `/agents/${agent.id}/tokens`,
    headers: { cookie },
    payload: { name: 'test', scopes },
  });
  expect(t.statusCode).toBe(201);
  return { id: agent.id, token: JSON.parse(t.body).token as string };
}

async function house(cookie: string): Promise<HouseView> {
  const res = await app.inject({ method: 'GET', url: '/house', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe('The House: who lives here', () => {
  it("shows the sponsor's agent with its sigil, and its now line once it sets one", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const robo = await agentWithToken(kohl.cookie, 'robo', ['status:write']);
    await app.inject({
      method: 'PUT',
      url: `/agents/${robo.id}/profile`,
      headers: { cookie: kohl.cookie },
      payload: { sigil: '⊖', summary: 'The one who counts.' },
    });
    let h = await house(kohl.cookie);
    expect(h.agents).toHaveLength(1);
    expect(h.agents[0]).toMatchObject({ preferredUsername: 'robo', sigil: '⊖', now: null });
    expect(h.agents[0].sponsor?.preferredUsername).toBe('kohl');

    const set = await app.inject({
      method: 'PUT',
      url: '/me/now',
      headers: bearer(robo.token),
      payload: { text: 'counting the queue' },
    });
    expect(set.statusCode).toBe(200);
    h = await house(kohl.cookie);
    expect(h.agents[0].now?.text).toBe('counting the queue');

    await app.inject({
      method: 'PUT',
      url: '/me/now',
      headers: bearer(robo.token),
      payload: { text: '' },
    });
    expect((await house(kohl.cookie)).agents[0].now).toBeNull();
  });

  it("a guest who came in on an invite sees the server's name and no pitch", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const srv = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: kohl.cookie },
      payload: { name: 'Demo House' },
    });
    expect(srv.statusCode).toBe(201);
    const serverId = JSON.parse(srv.body).id as string;
    const inv = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/invites`,
      headers: { cookie: kohl.cookie },
      payload: {},
    });
    const code = JSON.parse(inv.body).code as string;

    // The sponsor, before anyone's invited: his one server's name, and the pitch.
    let h = await house(kohl.cookie);
    expect(h.serverName).toBe('Demo House');
    expect(h.invited).toBe(false);

    const mom = await createTestUser(app, 'mom');
    const j = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: { cookie: mom.cookie },
    });
    expect(j.statusCode).toBe(200);
    h = await house(mom.cookie);
    expect(h.serverName).toBe('Demo House');
    expect(h.invited).toBe(true);

    // In two servers there's no one name to use.
    await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: kohl.cookie },
      payload: { name: 'Workshop' },
    });
    h = await house(kohl.cookie);
    expect(h.serverName).toBeNull();
  });

  it("someone who shares no server with an agent doesn't see it", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const luna = await createTestUser(app, 'luna');
    await agentWithToken(kohl.cookie, 'robo', ['status:write']);
    expect((await house(luna.cookie)).agents).toHaveLength(0);
  });

  it('only the agent sets its now line, and only with status:write', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const robo = await agentWithToken(kohl.cookie, 'robo', ['status:write']);
    const mute = await agentWithToken(kohl.cookie, 'mute', ['channels:read']);
    const asPerson = await app.inject({
      method: 'PUT',
      url: '/me/now',
      headers: { cookie: kohl.cookie },
      payload: { text: 'hi' },
    });
    expect(asPerson.statusCode).toBe(403);
    const noScope = await app.inject({
      method: 'PUT',
      url: '/me/now',
      headers: bearer(mute.token),
      payload: { text: 'hi' },
    });
    expect(noScope.statusCode).toBe(403);
    const tooLong = await app.inject({
      method: 'PUT',
      url: '/me/now',
      headers: bearer(robo.token),
      payload: { text: 'x'.repeat(141) },
    });
    expect(tooLong.statusCode).toBe(400);
    const tokenHouse = await app.inject({
      method: 'GET',
      url: '/house',
      headers: bearer(robo.token),
    });
    expect(tokenHouse.statusCode).toBe(403);
  });

  it('a sigil is a few characters at most', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const robo = await agentWithToken(kohl.cookie, 'robo', ['status:write']);
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${robo.id}/profile`,
      headers: { cookie: kohl.cookie },
      payload: { sigil: 'way too long' },
    });
    expect(res.statusCode).toBe(400);
  });
});
