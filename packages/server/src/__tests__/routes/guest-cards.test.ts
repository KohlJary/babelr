// SPDX-License-Identifier: MIT
/**
 * Guest cards: the inviter sets the person up first, makes the invite from
 * the card, and the welcome carries it. The person sees what was said
 * about them and decides whether the house may use it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb, wsSent } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { inviteArrivals } from '../../db/schema/welcome.ts';

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
const LABEL = 'MomLabel-7f3';
const NAME = 'Barbara-Q-9d1';
const NOTE = 'Loves crosswords; ask about the garden. note-5a2';
const SEEDS = "Kohl's mom, retired nurse, instagram @barb_gardens";

const headers = (who: Who) =>
  typeof who === 'string' ? { authorization: `Bearer ${who}` } : { cookie: who.cookie };

async function call(who: Who | null, method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: who ? headers(who) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: body as any, raw: res.body };
}

async function person(name: string) {
  const u = await createTestUser(app, name);
  await call(u, 'PUT', '/auth/publickey', { publicKey: KEY });
  return u;
}

/** Register through an invite link, the way the invite page does. */
async function registerWith(code: string, username: string): Promise<User> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      username,
      email: `${username}@test.babelr.local`,
      password: 'test-password-12chars',
      inviteCode: code,
    },
  });
  expect(res.statusCode).toBe(201);
  const raw = res.headers['set-cookie'];
  const c = (Array.isArray(raw) ? raw[0] : (raw as string)).split(';')[0];
  const u = { body: JSON.parse(res.body), cookie: c } as User;
  await call(u, 'PUT', '/auth/publickey', { publicKey: KEY });
  return u;
}

async function setup(opts: { seeds?: string | null } = {}) {
  const kohl = await person('kohl');
  const s = await call(kohl, 'POST', '/servers', { name: 'House' });
  const serverId = s.body.id as string;
  const a = await call(kohl, 'POST', '/agents', { username: 'robo', kind: 'agent' });
  const t = await call(kohl, 'POST', `/agents/${a.body.id}/tokens`, {
    name: 't',
    scopes: ['dms:read', 'dms:post', 'keys:write'],
  });
  const robo = t.body.token as string;
  await call(kohl, 'POST', `/servers/${serverId}/agents`, { agentId: a.body.id });
  await call(robo, 'PUT', '/auth/publickey', { publicKey: KEY });
  expect(
    (await call(robo, 'PUT', `/servers/${serverId}/welcome`, { welcoming: true })).status,
  ).toBe(200);
  const card = await call(kohl, 'POST', `/servers/${serverId}/guest-cards`, {
    name: NAME,
    label: LABEL,
    seeds: opts.seeds === undefined ? SEEDS : opts.seeds,
    note: NOTE,
    ...(opts.seeds === null ? {} : { facts: [{ key: 'occupation', value: 'retired nurse' }] }),
  });
  expect(card.status).toBe(201);
  expect(card.body.status).toBe('not_sent');
  return { kohl, serverId, robo, roboId: a.body.id as string, cardId: card.body.id as string };
}

async function makeInvite(kohl: User, cardId: string) {
  const inv = await call(kohl, 'POST', `/guest-cards/${cardId}/invite`, {});
  expect(inv.status).toBe(201);
  expect(inv.body.maxUses).toBe(1);
  return inv.body.code as string;
}

describe('guest cards', () => {
  it('invite from a card, join, and the welcome carries the card', async () => {
    const { kohl, robo, cardId, serverId } = await setup();
    const code = await makeInvite(kohl, cardId);

    // The invite page names the inviter, never the label.
    const preview = await call(null, 'GET', `/invites/${code}`);
    expect(preview.body.invitedBy).toEqual({ name: 'kohl' });
    expect(preview.raw).not.toContain(LABEL);
    expect(preview.raw).not.toContain(NAME);

    const mom = await registerWith(code, 'mom');
    const [w] = (await call(robo, 'GET', '/welcomes')).body;
    expect(w).toMatchObject({
      newcomer: { id: mom.body.id },
      invitedBy: { preferredUsername: 'kohl' },
      invitedAs: LABEL,
      card: { id: cardId, name: NAME, label: LABEL, note: NOTE, seeds: null },
      consented: null,
      seedsPending: true,
    });

    // The card shows who it became.
    const cards = (await call(kohl, 'GET', `/servers/${serverId}/guest-cards`)).body;
    expect(cards[0]).toMatchObject({ status: 'joined', joined: { id: mom.body.id } });
    expect((await call(kohl, 'POST', `/guest-cards/${cardId}/invite`, {})).status).toBe(409);
  });

  it('the consent screen shows the seeds verbatim; yes carries them (and an added link)', async () => {
    const { kohl, robo, roboId, cardId } = await setup();
    const mom = await registerWith(await makeInvite(kohl, cardId), 'mom');

    const screen = await call(mom, 'GET', '/me/arrivals?pending=true');
    expect(screen.status).toBe(200);
    expect(screen.body).toEqual([
      expect.objectContaining({
        seeds: SEEDS,
        facts: [{ key: 'occupation', value: 'retired nurse' }],
        invitedBy: { name: 'kohl' },
        lookupConsent: null,
      }),
    ]);
    // Never the inviter's shorthand, name or note.
    for (const secret of [LABEL, NAME, NOTE]) expect(screen.raw).not.toContain(secret);

    const yes = await call(mom, 'PUT', `/me/arrivals/${screen.body[0].id}/consent`, {
      consent: true,
      link: 'https://example.org/barb',
    });
    expect(yes.status).toBe(200);
    expect((await call(mom, 'GET', '/me/arrivals?pending=true')).body).toEqual([]);

    const [w] = (await call(robo, 'GET', '/welcomes')).body;
    expect(w.consented).toBe(true);
    expect(w.seedsPending).toBe(false);
    expect(w.card.seeds).toBe(`${SEEDS}\nhttps://example.org/barb`);
    expect(w.card.facts).toEqual([
      expect.objectContaining({ key: 'occupation', value: 'retired nurse', source: 'inviter' }),
    ]);
    expect(
      wsSent.some(
        (m) => m.to === roboId && (m.message as { type: string }).type === 'welcome:updated',
      ),
    ).toBe(true);
  });

  it('"No thanks" strips the seeds from the welcome and from welcomers’ view of the card', async () => {
    const { kohl, robo, cardId, serverId } = await setup();
    const mom = await registerWith(await makeInvite(kohl, cardId), 'mom');
    const [a] = (await call(mom, 'GET', '/me/arrivals')).body;
    await call(mom, 'PUT', `/me/arrivals/${a.id}/consent`, { consent: false, link: 'x' });

    const [w] = (await call(robo, 'GET', '/welcomes')).body;
    expect(w.consented).toBe(false);
    expect(w.card.seeds).toBeNull();
    expect(w.card.facts).toEqual([]);
    expect(JSON.stringify(w)).not.toContain('barb_gardens');
    const roboCards = (await call(robo, 'GET', `/servers/${serverId}/guest-cards`)).body;
    expect(roboCards[0].seeds).toBeNull();
    expect(roboCards[0].status).toBe('declined_lookup');
    // The inviter's own record keeps what they wrote.
    expect((await call(kohl, 'GET', `/servers/${serverId}/guest-cards`)).body[0].seeds).toBe(SEEDS);
    const [row] = await db.select().from(inviteArrivals);
    expect(row.addedLink).toBeNull();

    // They can change their mind later.
    await call(mom, 'PUT', `/me/arrivals/${a.id}/consent`, { consent: true });
    expect((await call(robo, 'GET', '/welcomes')).body[0].card.seeds).toBe(SEEDS);
  });

  it('no seeds means no consent screen', async () => {
    const { kohl, robo, cardId } = await setup({ seeds: null });
    const mom = await registerWith(await makeInvite(kohl, cardId), 'mom');
    expect((await call(mom, 'GET', '/me/arrivals?pending=true')).body).toEqual([]);
    const [w] = (await call(robo, 'GET', '/welcomes')).body;
    expect(w).toMatchObject({ invitedAs: LABEL, seedsPending: false, consented: null });
  });

  it('an ordinary invite works as before: no label, no card', async () => {
    const { kohl, robo, serverId } = await setup();
    const inv = await call(kohl, 'POST', `/servers/${serverId}/invites`, {});
    await registerWith(inv.body.code, 'luna');
    const [w] = (await call(robo, 'GET', '/welcomes')).body;
    expect(w).toMatchObject({
      invitedAs: null,
      card: null,
      seedsPending: false,
      invitedBy: { preferredUsername: 'kohl' },
    });
  });

  it('welcomers read cards before the person arrives; non-welcomers do not', async () => {
    const { kohl, robo, serverId, cardId } = await setup();
    await makeInvite(kohl, cardId);
    const early = await call(robo, 'GET', `/servers/${serverId}/guest-cards`);
    expect(early.status).toBe(200);
    expect(early.body[0]).toMatchObject({ id: cardId, label: LABEL, seeds: SEEDS, note: NOTE });
    // A welcomer sees the card, not the live link.
    expect(early.body[0].invite).toBeNull();
    expect(early.body[0].status).toBe('link_made');

    // A member who doesn't welcome sees only their own cards (none).
    const inv = await call(kohl, 'POST', `/servers/${serverId}/invites`, {});
    const dani = await registerWith(inv.body.code, 'dani');
    expect((await call(dani, 'GET', `/servers/${serverId}/guest-cards`)).body).toEqual([]);
    // Nor can they touch someone else's card.
    expect((await call(dani, 'PUT', `/guest-cards/${cardId}`, { name: 'x' })).status).toBe(404);
    expect((await call(dani, 'POST', `/guest-cards/${cardId}/invite`, {})).status).toBe(404);
    // An agent that stops welcoming stops seeing them.
    await call(robo, 'PUT', `/servers/${serverId}/welcome`, { welcoming: false });
    expect((await call(robo, 'GET', `/servers/${serverId}/guest-cards`)).body).toEqual([]);
    // Tokens can't make cards.
    expect(
      (await call(robo, 'POST', `/servers/${serverId}/guest-cards`, { name: 'n' })).status,
    ).toBe(403);
  });

  it('the label never shows up in member, profile or house responses', async () => {
    const { kohl, cardId, serverId } = await setup();
    const mom = await registerWith(await makeInvite(kohl, cardId), 'mom');
    const inv = await call(kohl, 'POST', `/servers/${serverId}/invites`, {});
    const dani = await registerWith(inv.body.code, 'dani');
    for (const who of [mom, dani]) {
      for (const url of [
        `/servers/${serverId}/members`,
        '/auth/me',
        '/house',
        '/dms',
        `/users/${mom.body.id}/publickey`,
        '/servers',
      ]) {
        const r = await call(who, 'GET', url);
        for (const secret of [LABEL, NAME, NOTE]) expect(r.raw, `${url}`).not.toContain(secret);
      }
    }
  });

  it('regenerating replaces the old link', async () => {
    const { kohl, cardId } = await setup();
    const first = await makeInvite(kohl, cardId);
    const second = await makeInvite(kohl, cardId);
    expect(second).not.toBe(first);
    expect((await call(null, 'GET', `/invites/${first}`)).status).toBe(410);
    expect((await call(null, 'GET', `/invites/${second}`)).body.valid).toBe(true);
  });
});
