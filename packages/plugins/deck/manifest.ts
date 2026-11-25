// SPDX-License-Identifier: MIT
import { definePlugin, canAccess } from '@babelr/plugin-sdk';
import type { PluginCaller } from '@babelr/plugin-sdk';
import { sql, type SQL } from 'drizzle-orm';
import {
  LIMITS,
  SLUG_RE,
  cleanHandle,
  parseRef,
  parseSlides,
  slugify,
  type DeckCard,
  type DeckPayload,
  type DeckPerson,
  type DeckSummary,
} from './deck.js';

/**
 * Decks: slide presentations that live in the house, and a way to ask
 * the presenter about any slide (Kohl: "a plugin for presentations, with
 * the ability for users to actively communicate with you if they have
 * questions/comments").
 *
 * A deck is Markdown (format in deck.ts), stored per server, with
 * presenters (who answer questions) and an explicit list of viewers.
 * Private by default: only the creator, the presenters and the listed
 * viewers can see it, and the check is made here, on every route, for
 * the caller's own actor. Anyone else gets 404, the same as for a slug
 * that doesn't exist, so a deck's existence isn't confirmed to them.
 *
 * Asking about a slide is an ordinary encrypted DM to a presenter,
 * written by the viewer's client: it starts with `[[deck:slug#n]]` and
 * then the question. This plugin never sees the question. Presenters
 * (usually the house's agents) answer it the way they answer any DM,
 * and can fetch the slide being asked about from GET /decks/:slug/slides/:n
 * with their own token (plugins:read).
 *
 * Writes (create, edit, delete) need plugins:write for an agent token.
 * Editing is for the creator and the presenters; deleting is for the
 * creator. Only local accounts can be presenters or viewers, and only
 * local callers can see a deck: the by-slug embed route answers a
 * federated caller with 404 whoever it is.
 */

interface DeckRow {
  id: string;
  slug: string;
  server_id: string;
  title: string;
  markdown: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface PersonRow {
  actor_id: string;
  role: 'presenter' | 'viewer';
  handle: string;
  display_name: string | null;
}

type Caller = Pick<PluginCaller, 'id'> & Partial<PluginCaller>;

class DeckError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
const NOT_FOUND = 'Deck not found';

export default definePlugin({
  id: 'deck',
  name: 'Decks',
  version: '0.1.0',
  description: 'Slide presentations with a way to ask the presenter about any slide.',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_deck_decks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE,
          server_id UUID NOT NULL,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          created_by UUID NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS plugin_deck_decks_server_idx ON plugin_deck_decks (server_id);

        CREATE TABLE IF NOT EXISTS plugin_deck_people (
          deck_id UUID NOT NULL REFERENCES plugin_deck_decks(id) ON DELETE CASCADE,
          actor_id UUID NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('presenter', 'viewer')),
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (deck_id, actor_id, role)
        );
        CREATE INDEX IF NOT EXISTS plugin_deck_people_actor_idx ON plugin_deck_people (actor_id);
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    const db = fastify.db;
    type Tx = { execute: (q: SQL) => PromiseLike<unknown> };

    async function deckRow(slug: string): Promise<DeckRow | null> {
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
      const rows = (await db.execute(
        sql`SELECT * FROM plugin_deck_decks WHERE slug = ${slug} LIMIT 1`,
      )) as unknown as DeckRow[];
      return rows[0] ?? null;
    }

    async function people(deckId: string): Promise<PersonRow[]> {
      return (await db.execute(
        sql`SELECT p.actor_id, p.role, a.preferred_username AS handle, a.display_name
              FROM plugin_deck_people p JOIN actors a ON a.id = p.actor_id
             WHERE p.deck_id = ${deckId}
             ORDER BY p.role, p.position`,
      )) as unknown as PersonRow[];
    }

    async function person(id: string): Promise<DeckPerson> {
      const rows = (await db.execute(
        sql`SELECT id, preferred_username AS handle, display_name FROM actors WHERE id = ${id}`,
      )) as unknown as Array<{ id: string; handle: string; display_name: string | null }>;
      const r = rows[0];
      return { id, handle: r?.handle ?? 'unknown', displayName: r?.display_name ?? null };
    }

    const asPerson = (p: PersonRow): DeckPerson => ({
      id: p.actor_id,
      handle: p.handle,
      displayName: p.display_name,
    });

    /** Local people and agents a list of handles names, in order, deduped.
     *  An unknown handle is a 400 that names it: whoever is writing the deck
     *  should know a viewer won't get in. */
    async function resolveHandles(raw: unknown, field: string, max: number): Promise<string[]> {
      if (!Array.isArray(raw)) throw new DeckError(`${field} must be a list of handles`, 400);
      const handles = [...new Set(raw.map((h) => (typeof h === 'string' ? cleanHandle(h) : '')))];
      if (handles.some((h) => !h)) throw new DeckError(`${field} must be a list of handles`, 400);
      if (handles.length > max) throw new DeckError(`${field}: at most ${max}`, 400);
      const ids: string[] = [];
      for (const h of handles) {
        const rows = (await db.execute(
          sql`SELECT id FROM actors
               WHERE local = true AND type IN ('Person', 'Service')
                 AND lower(preferred_username) = ${h} LIMIT 1`,
        )) as unknown as { id: string }[];
        if (!rows[0]) throw new DeckError(`${field}: no one here is @${h}`, 400);
        ids.push(rows[0].id);
      }
      return ids;
    }

    /** May `caller` see this deck? Creator, presenters and viewers, local only. */
    function seesFrom(row: DeckRow, ppl: PersonRow[], caller: Caller | null | undefined): boolean {
      if (!caller?.id || caller.local === false) return false;
      return row.created_by === caller.id || ppl.some((p) => p.actor_id === caller.id);
    }

    function editsFrom(row: DeckRow, ppl: PersonRow[], caller: Caller | null | undefined): boolean {
      if (!caller?.id || caller.local === false) return false;
      return (
        row.created_by === caller.id ||
        ppl.some((p) => p.role === 'presenter' && p.actor_id === caller.id)
      );
    }

    /** The deck if `caller` may see it, else a 404 (missing and private look alike). */
    async function visible(slug: string, caller: Caller | null | undefined) {
      const row = await deckRow(slug);
      if (!row) throw new DeckError(NOT_FOUND, 404);
      const ppl = await people(row.id);
      if (!seesFrom(row, ppl, caller)) throw new DeckError(NOT_FOUND, 404);
      return { row, ppl, canEdit: editsFrom(row, ppl, caller) };
    }

    function summary(row: DeckRow, ppl: PersonRow[], canEdit: boolean): DeckSummary {
      return {
        slug: row.slug,
        title: row.title,
        serverId: row.server_id,
        slideCount: parseSlides(row.markdown).length,
        presenters: ppl.filter((p) => p.role === 'presenter').map(asPerson),
        updatedAt: iso(row.updated_at),
        canEdit,
      };
    }

    async function payload(row: DeckRow, ppl: PersonRow[], canEdit: boolean): Promise<DeckPayload> {
      return {
        ...summary(row, ppl, canEdit),
        markdown: row.markdown,
        slides: parseSlides(row.markdown),
        createdBy: await person(row.created_by),
        createdAt: iso(row.created_at),
        ...(canEdit ? { viewers: ppl.filter((p) => p.role === 'viewer').map(asPerson) } : {}),
      };
    }

    function checkTitle(title: unknown): string {
      if (typeof title !== 'string' || !title.trim()) throw new DeckError('title is required', 400);
      if (title.trim().length > LIMITS.title) {
        throw new DeckError(`title: at most ${LIMITS.title} characters`, 400);
      }
      return title.trim();
    }

    function checkMarkdown(md: unknown): string {
      if (typeof md !== 'string') throw new DeckError('markdown is required', 400);
      if (md.length > LIMITS.markdown) {
        throw new DeckError(`markdown: at most ${LIMITS.markdown} characters`, 400);
      }
      const n = parseSlides(md).length;
      if (n === 0) throw new DeckError('a deck needs at least one slide', 400);
      if (n > LIMITS.slides) throw new DeckError(`at most ${LIMITS.slides} slides`, 400);
      return md;
    }

    async function setPeople(tx: Tx, deckId: string, role: 'presenter' | 'viewer', ids: string[]) {
      await tx.execute(
        sql`DELETE FROM plugin_deck_people WHERE deck_id = ${deckId} AND role = ${role}`,
      );
      for (let i = 0; i < ids.length; i++) {
        await tx.execute(
          sql`INSERT INTO plugin_deck_people (deck_id, actor_id, role, position)
              VALUES (${deckId}, ${ids[i]}, ${role}, ${i})`,
        );
      }
    }

    type Reply = { status: (n: number) => Reply; send: (b: unknown) => unknown };
    async function handle<T>(reply: unknown, fn: () => Promise<T>) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof DeckError) {
          return (reply as Reply).status(e.status).send({ error: e.message });
        }
        throw e;
      }
    }

    // The decks you can see: yours, the ones you present, the ones you're
    // a viewer of. Optionally one server's.
    fastify.get<{ Querystring: { serverId?: string } }>('/decks', async (request, reply) =>
      handle(reply, async () => {
        const me = request.actor!;
        const { serverId } = request.query;
        const rows = (await db.execute(
          sql`SELECT DISTINCT d.* FROM plugin_deck_decks d
                LEFT JOIN plugin_deck_people p ON p.deck_id = d.id
               WHERE (d.created_by = ${me.id} OR p.actor_id = ${me.id})
                 ${serverId ? sql`AND d.server_id::text = ${serverId}` : sql``}
               ORDER BY d.updated_at DESC
               LIMIT 200`,
        )) as unknown as DeckRow[];
        const out: DeckSummary[] = [];
        for (const row of rows) {
          const ppl = await people(row.id);
          if (!seesFrom(row, ppl, me)) continue;
          out.push(summary(row, ppl, editsFrom(row, ppl, me)));
        }
        return out;
      }),
    );

    fastify.post<{
      Body: {
        serverId?: string;
        title?: string;
        slug?: string;
        markdown?: string;
        presenters?: string[];
        viewers?: string[];
      };
    }>('/decks', async (request, reply) =>
      handle(reply, async () => {
        const me = request.actor!;
        const b = request.body ?? {};
        if (typeof b.serverId !== 'string' || !(await canAccess(fastify, me, b.serverId))) {
          throw new DeckError('Server not found', 404);
        }
        const title = checkTitle(b.title);
        const markdown = checkMarkdown(b.markdown);
        const slug = b.slug === undefined || b.slug === '' ? slugify(title) : b.slug;
        if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
          throw new DeckError('slug: lowercase letters, digits and hyphens', 400);
        }
        const presenters = await resolveHandles(
          b.presenters ?? [me.preferredUsername],
          'presenters',
          LIMITS.presenters,
        );
        if (presenters.length === 0) throw new DeckError('a deck needs a presenter', 400);
        const viewers = await resolveHandles(b.viewers ?? [], 'viewers', LIMITS.viewers);
        if ((await deckRow(slug)) !== null) {
          throw new DeckError('a deck with that slug already exists', 409);
        }
        const id = await db.transaction(async (tx: Tx) => {
          const res = (await tx.execute(
            sql`INSERT INTO plugin_deck_decks (slug, server_id, title, markdown, created_by)
                VALUES (${slug}, ${b.serverId}, ${title}, ${markdown}, ${me.id})
                RETURNING id`,
          )) as unknown as { id: string }[];
          await setPeople(tx, res[0].id, 'presenter', presenters);
          await setPeople(tx, res[0].id, 'viewer', viewers);
          return res[0].id;
        });
        const rows = (await db.execute(
          sql`SELECT * FROM plugin_deck_decks WHERE id = ${id}`,
        )) as unknown as DeckRow[];
        const ppl = await people(id);
        return (reply as unknown as Reply).status(201).send(await payload(rows[0], ppl, true));
      }),
    );

    fastify.get<{ Params: { slug: string } }>('/decks/:slug', async (request, reply) =>
      handle(reply, async () => {
        const { row, ppl, canEdit } = await visible(request.params.slug, request.actor);
        return payload(row, ppl, canEdit);
      }),
    );

    // One slide, for a presenter answering a question about it.
    fastify.get<{ Params: { slug: string; n: string } }>(
      '/decks/:slug/slides/:n',
      async (request, reply) =>
        handle(reply, async () => {
          const { row } = await visible(request.params.slug, request.actor);
          const slides = parseSlides(row.markdown);
          const n = Number(request.params.n);
          const slide = Number.isInteger(n) ? slides[n - 1] : undefined;
          if (!slide) throw new DeckError('No such slide', 404);
          return {
            deck: { slug: row.slug, title: row.title, slideCount: slides.length },
            slide,
          };
        }),
    );

    fastify.put<{
      Params: { slug: string };
      Body: { title?: string; markdown?: string; presenters?: string[]; viewers?: string[] };
    }>('/decks/:slug', async (request, reply) =>
      handle(reply, async () => {
        const me = request.actor!;
        const { row, canEdit } = await visible(request.params.slug, me);
        if (!canEdit) {
          throw new DeckError('Only the creator or a presenter can change this deck', 403);
        }
        const b = request.body ?? {};
        const title = b.title === undefined ? row.title : checkTitle(b.title);
        const markdown = b.markdown === undefined ? row.markdown : checkMarkdown(b.markdown);
        const presenters =
          b.presenters === undefined
            ? null
            : await resolveHandles(b.presenters, 'presenters', LIMITS.presenters);
        if (presenters && presenters.length === 0) {
          throw new DeckError('a deck needs a presenter', 400);
        }
        const viewers =
          b.viewers === undefined
            ? null
            : await resolveHandles(b.viewers, 'viewers', LIMITS.viewers);
        await db.transaction(async (tx: Tx) => {
          await tx.execute(
            sql`UPDATE plugin_deck_decks SET title = ${title}, markdown = ${markdown},
                       updated_at = NOW() WHERE id = ${row.id}`,
          );
          if (presenters) await setPeople(tx, row.id, 'presenter', presenters);
          if (viewers) await setPeople(tx, row.id, 'viewer', viewers);
        });
        const fresh = (await deckRow(row.slug))!;
        const ppl = await people(row.id);
        // A presenter who took themselves off may no longer see it.
        if (!seesFrom(fresh, ppl, me)) return { slug: fresh.slug, removed: true };
        return payload(fresh, ppl, editsFrom(fresh, ppl, me));
      }),
    );

    fastify.delete<{ Params: { slug: string } }>('/decks/:slug', async (request, reply) =>
      handle(reply, async () => {
        const me = request.actor!;
        const { row } = await visible(request.params.slug, me);
        if (row.created_by !== me.id) {
          throw new DeckError('Only the creator can delete this deck', 403);
        }
        await db.execute(sql`DELETE FROM plugin_deck_decks WHERE id = ${row.id}`);
        return { slug: row.slug, deleted: true };
      }),
    );
  },

  federationHandlers: {
    // [[deck:slug]] and [[deck:slug#n]]: the card a reference shows. Titles
    // only. Null (404) for anyone who isn't a viewer, and for every
    // federated caller.
    deck: {
      resolveBySlug: async (slug, ctx) => {
        const ref = parseRef(decodeURIComponent(slug));
        const caller = ctx.caller;
        if (!ref || !caller || caller.local !== true) return null;
        const rows = (await ctx.fastify.db.execute(
          sql`SELECT d.* FROM plugin_deck_decks d WHERE d.slug = ${ref.slug} LIMIT 1`,
        )) as unknown as DeckRow[];
        const row = rows[0];
        if (!row) return null;
        const allowed = (await ctx.fastify.db.execute(
          sql`SELECT 1 FROM plugin_deck_people WHERE deck_id = ${row.id} AND actor_id = ${caller.id}
              LIMIT 1`,
        )) as unknown as unknown[];
        if (row.created_by !== caller.id && allowed.length === 0) return null;
        const slides = parseSlides(row.markdown);
        return {
          slug: row.slug,
          title: row.title,
          slideCount: slides.length,
          slides: slides.map((s) => ({ n: s.n, title: s.title })),
        } satisfies DeckCard;
      },
    },
  },

  // setupClient lives in client-entry.ts (same split as polls).
});

export type { DeckCard, DeckPayload, DeckPerson, DeckSummary } from './deck.js';
