// SPDX-License-Identifier: Hippocratic-3.0
import { definePlugin } from '@babelr/plugin-sdk';
import { sql } from 'drizzle-orm';

/**
 * Review: an agent's drafts, waiting on its sponsor's say-so.
 *
 * An agent pushes items (a draft and why it wants to send it); its
 * sponsor works through them one at a time in the Review view and
 * decides: approve, hold, veto (with a reason), or edit (a new draft).
 * The agent reads the decisions and acts on them in its own world;
 * Babelr never sends anything anywhere. RoboKohl's outreach queue is
 * the first user, but nothing here knows about it.
 *
 * Rules:
 *   - Only agents and services push, and only to their own sponsor:
 *     the reviewer is never chosen by the agent, so an agent can't fill
 *     a stranger's inbox.
 *   - An item is visible to two actors: the agent that pushed it and
 *     its reviewer. Everyone else gets 404, the same as a missing item.
 *   - No WS broadcast. The view refetches; nothing about a draft
 *     reaches anyone else's socket.
 *   - Drafts are stored in plaintext in Postgres. They're the agent's
 *     drafts for its sponsor on the sponsor's Tower, not a channel.
 *
 * Agent routes (plugins:write / plugins:read):
 *   PUT    /items/:ref   {title, meta?, why?, body}  create or update;
 *                        changed content clears the decision
 *   GET    /items        own open items, with decisions
 *   DELETE /items/:ref   close: acted on, or decided elsewhere
 * Reviewer routes (sessions):
 *   GET    /inbox
 *   GET    /history     closed items, newest first: what was decided
 *   POST   /items/:id/decision {decision, reason?, body?}
 * Both, about one item (agents address it by ref, the reviewer by id):
 *   GET    /items/:key/messages
 *   POST   /items/:key/messages {body}
 *
 * The chat lets the reviewer talk a draft over with the agent. Each item
 * says whether it's awaiting the agent's reply (the last message is the
 * reviewer's), so an agent knows what to answer. An agent revising a
 * draft does it the usual way, a PUT with the new content, which brings
 * the item back undecided. Same visibility as the item: two actors.
 */

export type Decision = 'approve' | 'hold' | 'veto' | 'edit';
export const DECISIONS: readonly Decision[] = ['approve', 'hold', 'veto', 'edit'];

export interface ReviewItem {
  id: string;
  ref: string;
  agent: { id: string; preferredUsername: string; displayName: string | null };
  title: string;
  meta: string;
  why: string;
  body: string;
  revision: number;
  decision: Decision | null;
  reason: string;
  editedBody: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** The last chat message is the reviewer's: the agent owes a reply. */
  awaitingReply: boolean;
  /** When the agent acted on it and closed it; null while it's open. A
   *  closed item with no decision was decided somewhere else. */
  closedAt: string | null;
}

export interface ReviewMessage {
  id: string;
  from: 'agent' | 'reviewer';
  authorName: string;
  body: string;
  createdAt: string;
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const LIMITS = {
  title: 300,
  meta: 500,
  why: 4000,
  body: 100_000,
  reason: 4000,
  message: 20_000,
};

export class ReviewError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function text(v: unknown, what: keyof typeof LIMITS, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new ReviewError(`${what} is required`, 400);
    return '';
  }
  if (typeof v !== 'string' || v.length > LIMITS[what]) {
    throw new ReviewError(`${what} must be a string up to ${LIMITS[what]} chars`, 400);
  }
  if (required && !v.trim()) throw new ReviewError(`${what} is required`, 400);
  return v;
}

/** Validate a decision body. Veto needs a reason; edit needs the new draft. */
export function checkDecision(raw: unknown): {
  decision: Decision;
  reason: string;
  body: string | null;
} {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.decision !== 'string' || !DECISIONS.includes(b.decision as Decision)) {
    throw new ReviewError(`decision must be one of ${DECISIONS.join(', ')}`, 400);
  }
  const decision = b.decision as Decision;
  const reason = text(b.reason, 'reason', decision === 'veto');
  const body = decision === 'edit' ? text(b.body, 'body', true) : null;
  return { decision, reason, body };
}

interface ItemRow {
  id: string;
  ref: string;
  agent_id: string;
  username: string;
  display_name: string | null;
  title: string;
  meta: string;
  why: string;
  body: string;
  revision: number;
  decision: Decision | null;
  reason: string;
  edited_body: string | null;
  decided_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  message_count: number | string;
  last_author: string | null;
  closed_at: string | Date | null;
}

const iso = (v: string | Date) => new Date(v).toISOString();

function toItem(r: ItemRow): ReviewItem {
  return {
    id: r.id,
    ref: r.ref,
    agent: { id: r.agent_id, preferredUsername: r.username, displayName: r.display_name },
    title: r.title,
    meta: r.meta,
    why: r.why,
    body: r.body,
    revision: Number(r.revision),
    decision: r.decision,
    reason: r.reason,
    editedBody: r.edited_body,
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    messageCount: Number(r.message_count),
    awaitingReply: r.last_author !== null && r.last_author !== r.agent_id,
    closedAt: r.closed_at ? iso(r.closed_at) : null,
  };
}

const SELECT = sql`SELECT i.id, i.ref, i.agent_id, a.preferred_username AS username,
  a.display_name, i.title, i.meta, i.why, i.body, i.revision, i.decision, i.reason,
  i.edited_body, i.decided_at, i.created_at, i.updated_at, i.closed_at,
  (SELECT count(*) FROM plugin_review_messages m WHERE m.item_id = i.id) AS message_count,
  (SELECT m.author_id FROM plugin_review_messages m WHERE m.item_id = i.id
    ORDER BY m.seq DESC LIMIT 1) AS last_author
  FROM plugin_review_items i JOIN actors a ON a.id::text = i.agent_id`;

type Actor = {
  id: string;
  kind?: string;
  local?: boolean;
  sponsorId?: string | null;
  preferredUsername: string;
};

const isAgent = (a: Actor) => a.kind === 'agent' || a.kind === 'service';

export default definePlugin({
  id: 'review',
  name: 'Review',
  version: '0.1.0',
  description: "An agent's drafts, waiting on its sponsor: approve, hold, veto or edit.",
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_review_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id TEXT NOT NULL,
          reviewer_id TEXT NOT NULL,
          ref TEXT NOT NULL,
          title TEXT NOT NULL,
          meta TEXT NOT NULL DEFAULT '',
          why TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          decision TEXT,
          reason TEXT NOT NULL DEFAULT '',
          edited_body TEXT,
          decided_at TIMESTAMPTZ,
          closed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (agent_id, ref)
        );

        CREATE INDEX IF NOT EXISTS plugin_review_items_reviewer_idx
          ON plugin_review_items (reviewer_id) WHERE closed_at IS NULL;
      `,
    },
    {
      id: 2,
      name: 'messages',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_review_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          seq BIGSERIAL,
          item_id UUID NOT NULL REFERENCES plugin_review_items(id) ON DELETE CASCADE,
          author_id TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS plugin_review_messages_item_idx
          ON plugin_review_messages (item_id, seq);
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    fastify.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    function fail(
      reply: { status: (n: number) => { send: (b: unknown) => unknown } },
      err: unknown,
    ) {
      if (err instanceof ReviewError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }

    function agentOf(actor: Actor | null | undefined): Actor & { sponsorId: string } {
      if (!actor) throw new ReviewError('Not authenticated', 401);
      if (!isAgent(actor) || !actor.sponsorId) {
        throw new ReviewError('Only agents push items for review', 403);
      }
      return actor as Actor & { sponsorId: string };
    }

    function reviewerOf(actor: Actor | null | undefined): Actor {
      if (!actor) throw new ReviewError('Not authenticated', 401);
      if (isAgent(actor) || actor.local !== true) {
        throw new ReviewError('Review is for the people agents answer to', 403);
      }
      return actor;
    }

    function ref(v: string): string {
      if (!REF_RE.test(v)) throw new ReviewError('invalid ref', 400);
      return v;
    }

    // ── Agent ──────────────────────────────────────────────────────

    fastify.put<{ Params: { ref: string }; Body: Record<string, unknown> }>(
      '/items/:ref',
      async (request, reply) => {
        try {
          const agent = agentOf(request.actor as Actor);
          const r = ref(request.params.ref);
          const b = request.body ?? {};
          const title = text(b.title, 'title', true);
          const meta = text(b.meta, 'meta');
          const why = text(b.why, 'why');
          const body = text(b.body, 'body', true);
          // New content is a new question: clear any decision and reopen.
          // Same content again is a no-op, so an agent can push every pass.
          const rows = (await fastify.db.execute(
            sql`INSERT INTO plugin_review_items (agent_id, reviewer_id, ref, title, meta, why, body)
              VALUES (${agent.id}, ${agent.sponsorId}, ${r}, ${title}, ${meta}, ${why}, ${body})
              ON CONFLICT (agent_id, ref) DO UPDATE SET
                title = EXCLUDED.title, meta = EXCLUDED.meta, why = EXCLUDED.why,
                body = EXCLUDED.body, reviewer_id = EXCLUDED.reviewer_id,
                revision = plugin_review_items.revision + 1,
                decision = NULL, reason = '', edited_body = NULL, decided_at = NULL,
                closed_at = NULL, updated_at = NOW()
              WHERE (plugin_review_items.title, plugin_review_items.meta, plugin_review_items.why,
                     plugin_review_items.body) IS DISTINCT FROM
                    (EXCLUDED.title, EXCLUDED.meta, EXCLUDED.why, EXCLUDED.body)
                 OR plugin_review_items.closed_at IS NOT NULL
              RETURNING id`,
          )) as unknown as { id: string }[];
          const items = (await fastify.db.execute(
            sql`${SELECT} WHERE i.agent_id = ${agent.id} AND i.ref = ${r}`,
          )) as unknown as ItemRow[];
          return { item: toItem(items[0]), changed: rows.length > 0 };
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    fastify.get('/items', async (request, reply) => {
      try {
        const agent = agentOf(request.actor as Actor);
        const rows = (await fastify.db.execute(
          sql`${SELECT} WHERE i.agent_id = ${agent.id} AND i.closed_at IS NULL ORDER BY i.ref`,
        )) as unknown as ItemRow[];
        return rows.map(toItem);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.delete<{ Params: { ref: string } }>('/items/:ref', async (request, reply) => {
      try {
        const agent = agentOf(request.actor as Actor);
        const r = ref(request.params.ref);
        await fastify.db.execute(
          sql`UPDATE plugin_review_items SET closed_at = NOW(), updated_at = NOW()
            WHERE agent_id = ${agent.id} AND ref = ${r} AND closed_at IS NULL`,
        );
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    });

    // ── Chat about one item ────────────────────────────────────────

    /** The open item `key` names for this actor: by ref for its agent,
     *  by id for its reviewer. Anyone else: the missing-item 404. */
    async function itemFor(actor: Actor | null | undefined, key: string): Promise<ItemRow> {
      if (!actor) throw new ReviewError('Not authenticated', 401);
      let rows: ItemRow[];
      if (isAgent(actor)) {
        rows = (await fastify.db.execute(
          sql`${SELECT} WHERE i.agent_id = ${actor.id} AND i.ref = ${ref(key)}
            AND i.closed_at IS NULL`,
        )) as unknown as ItemRow[];
      } else {
        const me = reviewerOf(actor);
        if (!/^[0-9a-f-]{36}$/i.test(key)) throw new ReviewError('item not found', 404);
        rows = (await fastify.db.execute(
          sql`${SELECT} WHERE i.id = ${key} AND i.reviewer_id = ${me.id} AND i.closed_at IS NULL`,
        )) as unknown as ItemRow[];
      }
      if (!rows[0]) throw new ReviewError('item not found', 404);
      return rows[0];
    }

    interface MessageRow {
      id: string;
      author_id: string;
      author_name: string;
      body: string;
      created_at: string | Date;
    }

    async function messagesOf(item: ItemRow): Promise<ReviewMessage[]> {
      const rows = (await fastify.db.execute(
        sql`SELECT m.id, m.author_id, COALESCE(a.display_name, a.preferred_username) AS author_name,
            m.body, m.created_at
          FROM plugin_review_messages m LEFT JOIN actors a ON a.id::text = m.author_id
          WHERE m.item_id = ${item.id} ORDER BY m.seq`,
      )) as unknown as MessageRow[];
      return rows.map((m) => ({
        id: m.id,
        from: m.author_id === item.agent_id ? 'agent' : 'reviewer',
        authorName: m.author_name ?? '',
        body: m.body,
        createdAt: iso(m.created_at),
      }));
    }

    fastify.get<{ Params: { key: string } }>('/items/:key/messages', async (request, reply) => {
      try {
        const item = await itemFor(request.actor as Actor, request.params.key);
        return await messagesOf(item);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Params: { key: string }; Body: { body?: unknown } }>(
      '/items/:key/messages',
      async (request, reply) => {
        try {
          const actor = request.actor as Actor;
          const item = await itemFor(actor, request.params.key);
          const body = text(request.body?.body, 'message', true);
          await fastify.db.execute(
            sql`INSERT INTO plugin_review_messages (item_id, author_id, body)
              VALUES (${item.id}, ${actor.id}, ${body})`,
          );
          return reply.status(201).send(await messagesOf(item));
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // ── Reviewer ───────────────────────────────────────────────────

    fastify.get('/inbox', async (request, reply) => {
      try {
        const me = reviewerOf(request.actor as Actor);
        const rows = (await fastify.db.execute(
          sql`${SELECT} WHERE i.reviewer_id = ${me.id} AND i.closed_at IS NULL
            ORDER BY i.created_at, i.ref`,
        )) as unknown as ItemRow[];
        return rows.map(toItem);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.get('/history', async (request, reply) => {
      try {
        const me = reviewerOf(request.actor as Actor);
        const rows = (await fastify.db.execute(
          sql`${SELECT} WHERE i.reviewer_id = ${me.id} AND i.closed_at IS NOT NULL
            ORDER BY i.closed_at DESC LIMIT 200`,
        )) as unknown as ItemRow[];
        return rows.map(toItem);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Params: { id: string }; Body: unknown }>(
      '/items/:id/decision',
      async (request, reply) => {
        try {
          const me = reviewerOf(request.actor as Actor);
          if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) {
            throw new ReviewError('item not found', 404);
          }
          const d = checkDecision(request.body);
          // A decision may change until the agent acts on it and closes
          // the item; after that, it's the agent's world.
          const rows = (await fastify.db.execute(
            sql`UPDATE plugin_review_items SET decision = ${d.decision}, reason = ${d.reason},
                edited_body = ${d.body}, decided_at = NOW(), updated_at = NOW()
              WHERE id = ${request.params.id} AND reviewer_id = ${me.id} AND closed_at IS NULL
              RETURNING id`,
          )) as unknown as { id: string }[];
          if (rows.length === 0) throw new ReviewError('item not found', 404);
          const items = (await fastify.db.execute(
            sql`${SELECT} WHERE i.id = ${request.params.id}`,
          )) as unknown as ItemRow[];
          return toItem(items[0]);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  },
});
