// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import deckManifest from '@babelr/plugin-deck';
import { parseSlides, parseRef } from '@babelr/plugin-deck/deck';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';

/**
 * Decks, through the real plugin loader. kohl owns the server and makes
 * the deck; juniper (an agent) presents it; mom is its one viewer.
 * mallory is a member of the same server who isn't a viewer, and bob
 * isn't in the server at all. Privacy is the point: anyone who isn't the
 * creator, a presenter or a viewer gets a 404 for the deck, its slides
 * and its embed, and none of its text.
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
  await db.execute(sql`TRUNCATE plugin_deck_decks CASCADE`);
});

type Who = { cookie?: string; token?: string };

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  who: Who,
  payload?: unknown,
) {
  const headers: Record<string, string> = who.token
    ? { authorization: `Bearer ${who.token}` }
    : who.cookie
      ? { cookie: who.cookie }
      : {};
  const res = await app.inject({
    method,
    url: `/plugins/deck${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, json: () => JSON.parse(res.body), body: res.body };
}

const MD = `# Hello, house
Welcome in. The SECRET-INTRO line.

---

# The garden
- tomatoes
- the SECRET-GARDEN bed

---

# Questions?
> Ask anything.
`;

async function house() {
  const kohl = await createTestUser(app, 'kohl');
  const mom = await createTestUser(app, 'mom');
  const mallory = await createTestUser(app, 'mallory');
  const bob = await createTestUser(app, 'bob');
  const s = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: kohl.cookie },
    payload: { name: 'House' },
  });
  const serverId = JSON.parse(s.body).id as string;
  await app.inject({
    method: 'PUT',
    url: `/servers/${serverId}`,
    headers: { cookie: kohl.cookie },
    payload: { isPublic: true },
  });
  for (const who of [mom, mallory]) {
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: who.cookie },
    });
  }
  const agent = async (username: string, scopes: string[]) => {
    const a = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: kohl.cookie },
      payload: { username, kind: 'agent', displayName: username },
    });
    const agentId = JSON.parse(a.body).id as string;
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/agents`,
      headers: { cookie: kohl.cookie },
      payload: { agentId },
    });
    const t = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/tokens`,
      headers: { cookie: kohl.cookie },
      payload: { name: 'deck', scopes },
    });
    return { id: agentId, token: JSON.parse(t.body).token as string };
  };
  const juniper = await agent('juniper', ['plugins:read', 'plugins:write']);
  const moth = await agent('moth', ['plugins:read', 'plugins:write']);
  const readless = await agent('readless', ['dms:read']);
  return {
    serverId,
    kohl: { cookie: kohl.cookie },
    mom: { cookie: mom.cookie },
    mallory: { cookie: mallory.cookie },
    bob: { cookie: bob.cookie },
    juniper,
    moth,
    readless,
  };
}

async function withDeck(h: Awaited<ReturnType<typeof house>>) {
  const res = await call('POST', '/decks', h.kohl, {
    serverId: h.serverId,
    title: 'A year in the house',
    slug: 'a-year',
    markdown: MD,
    presenters: ['@juniper'],
    viewers: ['mom'],
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('deck format', () => {
  it('splits on a line holding only ---, takes each # Title, skips empties', () => {
    const slides = parseSlides(MD);
    expect(slides.map((s) => [s.n, s.title])).toEqual([
      [1, 'Hello, house'],
      [2, 'The garden'],
      [3, 'Questions?'],
    ]);
    expect(slides[1].body).toBe('- tomatoes\n- the SECRET-GARDEN bed');
    expect(parseSlides('---\n\n# Only\nx\n---\n---\n')).toHaveLength(1);
    expect(parseSlides('no title here')[0]).toEqual({ n: 1, title: '', body: 'no title here' });
  });

  it("doesn't split on --- inside a fenced code block, or on ----, or on ## headings", () => {
    const slides = parseSlides('# A\n```\n---\n```\n----\n## not a title\n---\n# B');
    expect(slides).toHaveLength(2);
    expect(slides[0].body).toContain('```\n---\n```');
    expect(slides[0].body).toContain('----');
  });

  it('reads [[deck:slug]] and [[deck:slug#n]] refs', () => {
    expect(parseRef('a-year')).toEqual({ slug: 'a-year', n: null });
    expect(parseRef('a-year#3')).toEqual({ slug: 'a-year', n: 3 });
    expect(parseRef('../etc#3')).toBeNull();
  });
});

describe('deck plugin', () => {
  it('serves the deck, its slides and its card to the creator, presenter and viewer', async () => {
    const h = await house();
    const made = await withDeck(h);
    expect(made.slideCount).toBe(3);
    expect(made.presenters.map((p: { handle: string }) => p.handle)).toEqual(['juniper']);
    expect(made.viewers.map((p: { handle: string }) => p.handle)).toEqual(['mom']);
    expect(made.createdAt).toBeTruthy();
    expect(made.updatedAt).toBeTruthy();

    for (const who of [h.kohl, h.mom, { token: h.juniper.token }]) {
      const deck = await call('GET', '/decks/a-year', who);
      expect(deck.status).toBe(200);
      expect(deck.json().slides[1].title).toBe('The garden');
      const slide = await call('GET', '/decks/a-year/slides/2', who);
      expect(slide.status).toBe(200);
      expect(slide.json().slide.body).toContain('SECRET-GARDEN');
      expect(slide.json().deck).toEqual({
        slug: 'a-year',
        title: 'A year in the house',
        slideCount: 3,
      });
      const card = await call('GET', `/deck/by-slug/${encodeURIComponent('a-year#2')}`, who);
      expect(card.status).toBe(200);
      expect(card.json().slides[1]).toEqual({ n: 2, title: 'The garden' });
      expect(card.body).not.toContain('SECRET');
      const list = await call('GET', '/decks', who);
      expect(list.json().map((d: { slug: string }) => d.slug)).toEqual(['a-year']);
    }
    // A viewer sees who presents it, not who else was invited to see it.
    const asMom = (await call('GET', '/decks/a-year', h.mom)).json();
    expect(asMom.canEdit).toBe(false);
    expect(asMom.viewers).toBeUndefined();
    expect((await call('GET', '/decks/a-year/slides/9', h.mom)).status).toBe(404);
  });

  it('404s a non-viewer for the deck, its slides, its embed and the list, with none of its text', async () => {
    const h = await house();
    await withDeck(h);
    // mallory is in the same server; bob isn't; moth is an agent in the
    // server who isn't presenting.
    for (const who of [h.mallory, h.bob, { token: h.moth.token }]) {
      for (const url of [
        '/decks/a-year',
        '/decks/a-year/slides/1',
        '/decks/a-year/slides/2',
        '/deck/by-slug/a-year',
        `/deck/by-slug/${encodeURIComponent('a-year#2')}`,
      ]) {
        const res = await call('GET', url, who);
        expect(res.status, url).toBe(404);
        expect(res.body).not.toContain('SECRET');
        expect(res.body).not.toContain('A year in the house');
      }
      // A private deck and a missing one answer alike.
      const missing = await call('GET', '/decks/no-such-deck', who);
      expect((await call('GET', '/decks/a-year', who)).body).toBe(missing.body);
      expect((await call('GET', '/decks', who)).json()).toEqual([]);
      expect((await call('PUT', '/decks/a-year', who, { title: 'mine now' })).status).toBe(404);
      expect((await call('DELETE', '/decks/a-year', who)).status).toBe(404);
    }
  });

  it('refuses the signed-out (401) and a token without plugins:read (403)', async () => {
    const h = await house();
    await withDeck(h);
    for (const url of [
      '/decks',
      '/decks/a-year',
      '/decks/a-year/slides/1',
      '/deck/by-slug/a-year',
    ]) {
      const anon = await call('GET', url, {});
      expect(anon.status, url).toBe(401);
      expect(anon.body).not.toContain('SECRET');
      expect((await call('GET', url, { token: h.readless.token })).status, url).toBe(403);
    }
  });

  it('never answers a federated caller, whoever it is', async () => {
    const h = await house();
    await withDeck(h);
    const mom = (await db.execute(
      sql`SELECT id, uri FROM actors WHERE preferred_username = 'mom'`,
    )) as unknown as Array<{ id: string; uri: string }>;
    const resolve = deckManifest.federationHandlers!.deck.resolveBySlug;
    expect(
      await resolve('a-year', { fastify: app, caller: { ...mom[0], local: false } }),
    ).toBeNull();
    expect(
      await resolve('a-year', { fastify: app, caller: { ...mom[0], local: true } }),
    ).not.toBeNull();
  });

  it('lets the creator and presenters edit; a viewer gets 403', async () => {
    const h = await house();
    await withDeck(h);
    expect((await call('PUT', '/decks/a-year', h.mom, { title: 'x' })).status).toBe(403);
    expect((await call('DELETE', '/decks/a-year', h.mom)).status).toBe(403);
    // The presenter edits with its own token.
    const edited = await call(
      'PUT',
      '/decks/a-year',
      { token: h.juniper.token },
      {
        markdown: `${MD}\n---\n# One more`,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json().slideCount).toBe(4);
    // ...but deleting is for the creator.
    expect((await call('DELETE', '/decks/a-year', { token: h.juniper.token })).status).toBe(403);
    // Taking mom off the viewers takes the deck away from her.
    const off = await call('PUT', '/decks/a-year', h.kohl, { viewers: [] });
    expect(off.status).toBe(200);
    expect((await call('GET', '/decks/a-year', h.mom)).status).toBe(404);
    expect((await call('GET', '/deck/by-slug/a-year', h.mom)).status).toBe(404);
    expect((await call('DELETE', '/decks/a-year', h.kohl)).status).toBe(200);
    expect((await call('GET', '/decks/a-year', h.kohl)).status).toBe(404);
  });

  it('lets an agent make a deck in its own server, presenting it by default', async () => {
    const h = await house();
    const res = await call(
      'POST',
      '/decks',
      { token: h.juniper.token },
      {
        serverId: h.serverId,
        title: 'Juniper’s notes',
        markdown: '# One\nhi',
        viewers: ['kohl'],
      },
    );
    expect(res.status).toBe(201);
    expect(res.json().slug).toBe('juniper-s-notes');
    expect(res.json().presenters[0].handle).toBe('juniper');
    expect((await call('GET', '/decks/juniper-s-notes', h.kohl)).status).toBe(200);
    expect((await call('GET', '/decks/juniper-s-notes', h.mom)).status).toBe(404);
  });

  it('checks what a deck is made of', async () => {
    const h = await house();
    const base = { serverId: h.serverId, title: 'T', markdown: '# a', presenters: ['juniper'] };
    // Not a member of the server: same answer as no such server.
    expect((await call('POST', '/decks', h.bob, base)).status).toBe(404);
    const bad = await call('POST', '/decks', h.kohl, { ...base, viewers: ['nobody-here'] });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toContain('@nobody-here');
    // A server isn't a person.
    expect((await call('POST', '/decks', h.kohl, { ...base, viewers: ['house'] })).status).toBe(
      400,
    );
    expect((await call('POST', '/decks', h.kohl, { ...base, markdown: '---\n' })).status).toBe(400);
    expect((await call('POST', '/decks', h.kohl, { ...base, slug: 'Bad Slug' })).status).toBe(400);
    expect((await call('POST', '/decks', h.kohl, { ...base, presenters: [] })).status).toBe(400);
    expect((await call('POST', '/decks', h.kohl, { ...base, slug: 'one' })).status).toBe(201);
    expect((await call('POST', '/decks', h.kohl, { ...base, slug: 'one' })).status).toBe(409);
  });
});
