// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { isValidEventSlug } from '@babelr/shared';
import { actors } from '../../db/schema/actors.ts';
import { collectionItems } from '../../db/schema/collections.ts';

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
});

async function createServer(username: string) {
  const user = await createTestUser(app, username);
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: user.cookie },
    payload: { name: `${username}_s` },
  });
  const server = JSON.parse(serverRes.body);
  return { user, serverId: server.id };
}

async function joinAsMember(cookie: string, serverId: string) {
  const [server] = await db.select().from(actors).where(eq(actors.id, serverId)).limit(1);
  const me = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body,
  );
  await db.insert(collectionItems).values({
    collectionUri: server!.followersUri!,
    collectionId: null,
    itemUri: me.uri,
    itemId: me.id,
    properties: { role: 'member' },
  });
  return me.id;
}

function futureIso(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

describe('Event slug generation on create', () => {
  it('assigns a slug to every new server event', async () => {
    const { user, serverId } = await createServer('event_slug_gen');
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: user.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Kickoff',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    expect(res.statusCode).toBe(201);
    const event = JSON.parse(res.body);
    expect(event.slug).toBeTruthy();
    expect(isValidEventSlug(event.slug)).toBe(true);
  });

  it('assigns a slug to user events too', async () => {
    const user = await createTestUser(app, 'event_slug_user');
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: user.cookie },
      payload: {
        ownerType: 'user',
        title: 'Dentist',
        startAt: futureIso(60),
        endAt: futureIso(90),
      },
    });
    expect(res.statusCode).toBe(201);
    const event = JSON.parse(res.body);
    expect(isValidEventSlug(event.slug)).toBe(true);
  });

  it('produces distinct slugs across multiple creates', async () => {
    const { user, serverId } = await createServer('event_slug_multi');
    const slugs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/events',
        headers: { cookie: user.cookie },
        payload: {
          ownerType: 'server',
          ownerId: serverId,
          title: `Event ${i}`,
          startAt: futureIso(60 + i),
          endAt: futureIso(120 + i),
        },
      });
      const event = JSON.parse(res.body);
      slugs.add(event.slug);
    }
    expect(slugs.size).toBe(8);
  });
});

describe('GET /events/by-slug/:slug', () => {
  it('returns the embed envelope for the creator', async () => {
    const { user, serverId } = await createServer('event_slug_lookup');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: user.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Weekly sync',
        description: 'Catch up on the week',
        location: 'Main hall',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const lookupRes = await app.inject({
      method: 'GET',
      url: `/events/by-slug/${event.slug}`,
      headers: { cookie: user.cookie },
    });
    expect(lookupRes.statusCode).toBe(200);
    const body = JSON.parse(lookupRes.body);
    expect(body.id).toBe(event.id);
    expect(body.slug).toBe(event.slug);
    expect(body.title).toBe('Weekly sync');
    expect(body.description).toBe('Catch up on the week');
    expect(body.location).toBe('Main hall');
    // Creator is auto-RSVPed as going.
    expect(body.myRsvp).toBe('going');
    expect(body.counts.going).toBe(1);
  });

  it('returns the envelope for other server members', async () => {
    const { user: creator, serverId } = await createServer('event_slug_any');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: creator.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Member-visible',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const reader = await createTestUser(app, 'event_slug_reader');
    await joinAsMember(reader.cookie, serverId);

    const res = await app.inject({
      method: 'GET',
      url: `/events/by-slug/${event.slug}`,
      headers: { cookie: reader.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.myRsvp).toBeNull();
  });

  it('returns 404 for non-members (no leak of existence)', async () => {
    const { user: owner, serverId } = await createServer('event_slug_private');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: owner.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Secret',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const stranger = await createTestUser(app, 'event_slug_stranger');
    const res = await app.inject({
      method: 'GET',
      url: `/events/by-slug/${event.slug}`,
      headers: { cookie: stranger.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a malformed slug', async () => {
    const user = await createTestUser(app, 'event_slug_bad');
    const res = await app.inject({
      method: 'GET',
      url: '/events/by-slug/NOT_VALID',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent slug', async () => {
    const user = await createTestUser(app, 'event_slug_missing');
    const res = await app.inject({
      method: 'GET',
      url: '/events/by-slug/zzzzzzzzzz',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/events/by-slug/abcdefghjk',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /events/by-slug/:slug/rsvp', () => {
  it('lets a server member RSVP via the embed slug', async () => {
    const { user: creator, serverId } = await createServer('event_rsvp_slug');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: creator.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Invite list test',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const member = await createTestUser(app, 'event_rsvp_member');
    await joinAsMember(member.cookie, serverId);

    const rsvpRes = await app.inject({
      method: 'POST',
      url: `/events/by-slug/${event.slug}/rsvp`,
      headers: { cookie: member.cookie },
      payload: { status: 'going' },
    });
    expect(rsvpRes.statusCode).toBe(200);
    const body = JSON.parse(rsvpRes.body);
    expect(body.myRsvp).toBe('going');
    // Creator + new member
    expect(body.counts.going).toBe(2);
  });

  it('rejects non-members trying to RSVP to a server event', async () => {
    const { user: creator, serverId } = await createServer('event_rsvp_block');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: creator.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Members only',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const outsider = await createTestUser(app, 'event_rsvp_outsider');
    const res = await app.inject({
      method: 'POST',
      url: `/events/by-slug/${event.slug}/rsvp`,
      headers: { cookie: outsider.cookie },
      payload: { status: 'going' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects invalid status values', async () => {
    const { user, serverId } = await createServer('event_rsvp_invalid');
    const createRes = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: user.cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Status check',
        startAt: futureIso(60),
        endAt: futureIso(120),
      },
    });
    const event = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/events/by-slug/${event.slug}/rsvp`,
      headers: { cookie: user.cookie },
      payload: { status: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('wiki-links parser — event refs', () => {
  it('parses [[event:slug]] as event-kind refs', async () => {
    const { parseWikiRefs, extractEventSlugs } = await import('@babelr/shared');
    const src = 'Join us for [[event:abcdefghjk]] this week.';
    const refs = parseWikiRefs(src);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('event');
    expect(refs[0].slug).toBe('abcdefghjk');
    expect(extractEventSlugs(src)).toEqual(['abcdefghjk']);
  });

  it('distinguishes event, message, and page refs', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const src =
      'See [[some-page]], read [[msg:abcdefghjk]], and join [[event:mnpqrstuvw]].';
    const refs = parseWikiRefs(src);
    expect(refs.map((r) => r.kind)).toEqual(['page', 'message', 'event']);
  });

  it('ignores event refs inside code blocks', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const src = 'Use the syntax `[[event:abcdefghjk]]` to embed.';
    const refs = parseWikiRefs(src);
    expect(refs).toHaveLength(0);
  });

  it('parses [[wiki:slug]] as a page ref', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const refs = parseWikiRefs('See [[wiki:my-page]] for details.');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('page');
    expect(refs[0].slug).toBe('my-page');
    expect(refs[0].origin).toBeUndefined();
  });

  it('bare [[slug]] still works as backwards-compatible page ref', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const refs = parseWikiRefs('Check [[my-page]] for info.');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('page');
    expect(refs[0].slug).toBe('my-page');
  });

  it('parses [[server@tower:kind:slug]] cross-tower refs', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const refs = parseWikiRefs('See [[engineering@partner.com:wiki:api-spec]] for the spec.');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('page');
    expect(refs[0].slug).toBe('api-spec');
    expect(refs[0].origin).toEqual({ server: 'engineering', tower: 'partner.com' });
  });

  it('parses cross-tower refs for all kinds', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const src = [
      '[[ops@acme.com:msg:abcdefghjk]]',
      '[[ops@acme.com:event:mnpqrstuvw]]',
      '[[ops@acme.com:file:xyz1234567]]',
      '[[ops@acme.com:wiki:runbook]]',
    ].join(' ');
    const refs = parseWikiRefs(src);
    expect(refs).toHaveLength(4);
    expect(refs.map((r) => r.kind)).toEqual(['message', 'event', 'file', 'page']);
    expect(refs.every((r) => r.origin?.server === 'ops' && r.origin?.tower === 'acme.com')).toBe(true);
  });
});
