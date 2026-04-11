// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { generateMessageSlug, isValidMessageSlug } from '@babelr/shared';
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

async function createServerAndChannel(username: string) {
  const user = await createTestUser(app, username);
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: user.cookie },
    payload: { name: `${username}_s` },
  });
  const server = JSON.parse(serverRes.body);
  const channelsRes = await app.inject({
    method: 'GET',
    url: `/servers/${server.id}/channels`,
    headers: { cookie: user.cookie },
  });
  const channels = JSON.parse(channelsRes.body);
  return { user, serverId: server.id, channelId: channels[0].id };
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

describe('generateMessageSlug helper', () => {
  it('produces 10-char slugs matching the validation regex', () => {
    for (let i = 0; i < 100; i++) {
      const slug = generateMessageSlug();
      expect(slug).toHaveLength(10);
      expect(isValidMessageSlug(slug)).toBe(true);
    }
  });

  it('generates distinct slugs (no seed collision)', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      slugs.add(generateMessageSlug());
    }
    // Allow for negligible collision but at 31^10 the probability
    // of any two from 1000 colliding is vanishingly small.
    expect(slugs.size).toBe(1000);
  });
});

describe('isValidMessageSlug', () => {
  it('rejects slugs with invalid characters', () => {
    expect(isValidMessageSlug('ABCDEFGHIJ')).toBe(false); // uppercase
    expect(isValidMessageSlug('0abcdefghj')).toBe(false); // contains 0
    expect(isValidMessageSlug('abcdef1hjk')).toBe(false); // contains 1
    expect(isValidMessageSlug('abcdoighjk')).toBe(false); // contains o
    expect(isValidMessageSlug('abcdlighjk')).toBe(false); // contains l
  });

  it('rejects wrong-length strings', () => {
    expect(isValidMessageSlug('abcdefghi')).toBe(false); // 9
    expect(isValidMessageSlug('abcdefghjkm')).toBe(false); // 11
    expect(isValidMessageSlug('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidMessageSlug(null)).toBe(false);
    expect(isValidMessageSlug(undefined)).toBe(false);
    expect(isValidMessageSlug(12345)).toBe(false);
  });
});

describe('Message slug generation on create', () => {
  it('assigns a slug to every new message', async () => {
    const { user, channelId } = await createServerAndChannel('slug_gen');
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: user.cookie },
      payload: { content: 'first message' },
    });
    expect(res.statusCode).toBe(201);
    const { message } = JSON.parse(res.body);
    expect(message.slug).toBeTruthy();
    expect(isValidMessageSlug(message.slug)).toBe(true);
  });

  it('produces distinct slugs across multiple creates', async () => {
    const { user, channelId } = await createServerAndChannel('slug_multi');
    const slugs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/channels/${channelId}/messages`,
        headers: { cookie: user.cookie },
        payload: { content: `msg ${i}` },
      });
      const { message } = JSON.parse(res.body);
      slugs.add(message.slug);
    }
    expect(slugs.size).toBe(10);
  });
});

describe('GET /messages/by-slug/:slug', () => {
  it('returns the message envelope for a channel member', async () => {
    const { user, serverId, channelId } = await createServerAndChannel('slug_lookup');
    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: user.cookie },
      payload: { content: 'hello from admin' },
    });
    const { message } = JSON.parse(postRes.body);

    const lookupRes = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/${message.slug}`,
      headers: { cookie: user.cookie },
    });
    expect(lookupRes.statusCode).toBe(200);
    const body = JSON.parse(lookupRes.body);
    expect(body.id).toBe(message.id);
    expect(body.slug).toBe(message.slug);
    expect(body.content).toBe('hello from admin');
    expect(body.channelId).toBe(channelId);
    expect(body.serverId).toBe(serverId);
    expect(body.author).toBeDefined();
    expect(body.channelName).toBe('general');
  });

  it('returns the envelope for any server member (not just the author)', async () => {
    const { user: author, serverId, channelId } = await createServerAndChannel('slug_any');
    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: author.cookie },
      payload: { content: 'public message' },
    });
    const { message } = JSON.parse(postRes.body);

    const reader = await createTestUser(app, 'slug_reader');
    await joinAsMember(reader.cookie, serverId);

    const lookupRes = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/${message.slug}`,
      headers: { cookie: reader.cookie },
    });
    expect(lookupRes.statusCode).toBe(200);
  });

  it('returns 404 for non-members (no leak of existence)', async () => {
    const { user: owner, channelId } = await createServerAndChannel('slug_private');
    const postRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: owner.cookie },
      payload: { content: 'secret' },
    });
    const { message } = JSON.parse(postRes.body);

    const stranger = await createTestUser(app, 'slug_stranger');
    const lookupRes = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/${message.slug}`,
      headers: { cookie: stranger.cookie },
    });
    expect(lookupRes.statusCode).toBe(404);
  });

  it('returns 404 for a nonexistent slug', async () => {
    const { user } = await createServerAndChannel('slug_missing');
    const fakeSlug = 'zzzzzzzzzz'; // valid format, nonexistent
    const res = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/${fakeSlug}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a malformed slug', async () => {
    const { user } = await createServerAndChannel('slug_bad');
    const res = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/NOT_A_VALID_SLUG`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/messages/by-slug/abcdefghjk`,
    });
    expect(res.statusCode).toBe(401);
  });
});
