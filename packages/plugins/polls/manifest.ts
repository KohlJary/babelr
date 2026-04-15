// SPDX-License-Identifier: Hippocratic-3.0
import { definePlugin } from '@babelr/plugin-sdk';
import { sql } from 'drizzle-orm';

/**
 * Polls & Quizzes — first real plugin validating the SDK.
 *
 * What it ships:
 *   - [[poll:slug]] embed kind (inline = compact bar chart; preview =
 *     full poll with click-to-vote)
 *   - Server routes: create, get-by-slug, vote, close
 *   - Federation: remote actors can resolve + vote on local polls via
 *     the same server routes (authenticated via HTTP signature)
 *   - Real-time vote-count sync via plugin-scoped WS broadcast
 *   - Translation: poll questions and option labels flow through the
 *     standard translation pipeline at render time (plaintext storage)
 *
 * Not in v1:
 *   - Poll creation UI — create via POST /plugins/polls/polls for now;
 *     the chat-input "+" menu integration is a separate follow-up
 *   - Multi-choice polls — single-choice only for v1
 *   - Quizzes (correct answer scoring) — follow-up once poll basics are
 *     proven
 */

interface PollRow {
  id: string;
  slug: string;
  question: string;
  created_by: string;
  server_id: string | null;
  created_at: string;
  closed_at: string | null;
  allow_revote: boolean;
}

interface PollOptionRow {
  id: string;
  poll_id: string;
  position: number;
  label: string;
}

interface PollVoteRow {
  poll_id: string;
  actor_uri: string;
  option_id: string;
  voted_at: string;
}

interface PollPayload {
  slug: string;
  question: string;
  createdBy: string;
  closedAt: string | null;
  allowRevote: boolean;
  options: Array<{
    id: string;
    position: number;
    label: string;
    voteCount: number;
  }>;
  totalVotes: number;
  /** The requesting actor's current vote, if any. Populated for local
   *  sessions; omitted for federation resolver responses (the remote
   *  Tower computes this on their side from their own actor). */
  myVoteOptionId?: string | null;
}

export default definePlugin({
  id: 'polls',
  name: 'Polls & Quizzes',
  version: '0.1.0',
  description:
    'Inline polls you can vote on from anywhere a [[kind:slug]] embed renders.',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_polls_polls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE,
          question TEXT NOT NULL,
          created_by UUID NOT NULL,
          server_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          allow_revote BOOLEAN NOT NULL DEFAULT TRUE
        );
        CREATE INDEX IF NOT EXISTS plugin_polls_polls_server_idx ON plugin_polls_polls (server_id);

        CREATE TABLE IF NOT EXISTS plugin_polls_options (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          poll_id UUID NOT NULL REFERENCES plugin_polls_polls(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          label TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS plugin_polls_options_poll_idx ON plugin_polls_options (poll_id, position);

        CREATE TABLE IF NOT EXISTS plugin_polls_votes (
          poll_id UUID NOT NULL REFERENCES plugin_polls_polls(id) ON DELETE CASCADE,
          actor_uri TEXT NOT NULL,
          option_id UUID NOT NULL REFERENCES plugin_polls_options(id) ON DELETE CASCADE,
          voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (poll_id, actor_uri)
        );
        CREATE INDEX IF NOT EXISTS plugin_polls_votes_option_idx ON plugin_polls_votes (option_id);
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    async function loadPoll(slug: string): Promise<PollPayload | null> {
      const polls = (await fastify.db.execute(
        sql`SELECT * FROM plugin_polls_polls WHERE slug = ${slug} LIMIT 1`,
      )) as unknown as PollRow[];
      const poll = polls[0];
      if (!poll) return null;
      const options = (await fastify.db.execute(
        sql`SELECT o.id, o.position, o.label,
                   (SELECT COUNT(*) FROM plugin_polls_votes v WHERE v.option_id = o.id) AS vote_count
            FROM plugin_polls_options o
            WHERE o.poll_id = ${poll.id}
            ORDER BY o.position`,
      )) as unknown as Array<PollOptionRow & { vote_count: string }>;
      return {
        slug: poll.slug,
        question: poll.question,
        createdBy: poll.created_by,
        closedAt: poll.closed_at,
        allowRevote: poll.allow_revote,
        options: options.map((o) => ({
          id: o.id,
          position: o.position,
          label: o.label,
          voteCount: Number(o.vote_count),
        })),
        totalVotes: options.reduce((sum, o) => sum + Number(o.vote_count), 0),
      };
    }

    function randomSlug(): string {
      return Math.random().toString(36).slice(2, 12);
    }

    /** Push a live update to every subscriber so embedded polls across
     *  open clients re-render with the new counts. We piggyback on the
     *  broadcastToAllSubscribers decorator the WS plugin exposes. */
    async function broadcastPoll(slug: string) {
      const payload = await loadPoll(slug);
      if (!payload) return;
      fastify.broadcastToAllSubscribers({
        // Plugin-namespaced event — the WS type system treats unknown
        // types as opaque pass-through, which is exactly what plugins
        // need. Clients filter by this string.
        type: 'plugin:polls:updated' as never,
        payload: payload as never,
      });
    }

    fastify.post<{
      Body: { question: string; options: string[]; serverId?: string };
    }>('/polls', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { question, options, serverId } = request.body ?? {};
      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return reply.status(400).send({ error: 'question is required' });
      }
      if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
        return reply.status(400).send({ error: 'options must have 2–10 entries' });
      }
      const slug = randomSlug();
      const actorId = request.actor.id;
      const trimmedQuestion = question.trim();
      const res = (await fastify.db.execute(
        sql`INSERT INTO plugin_polls_polls (slug, question, created_by, server_id)
            VALUES (${slug}, ${trimmedQuestion}, ${actorId}, ${serverId ?? null})
            RETURNING id`,
      )) as unknown as { id: string }[];
      const pollId = res[0].id;
      for (let i = 0; i < options.length; i++) {
        const label = options[i];
        if (typeof label !== 'string' || !label.trim()) continue;
        await fastify.db.execute(
          sql`INSERT INTO plugin_polls_options (poll_id, position, label)
              VALUES (${pollId}, ${i}, ${label.trim()})`,
        );
      }
      const payload = await loadPoll(slug);
      return payload;
    });

    fastify.get<{ Querystring: { serverId?: string } }>(
      '/polls',
      async (request, reply) => {
        if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
        const { serverId } = request.query;
        // Server-scoped list for now. Global listing (cross-server
        // recent activity dashboards, etc.) is a follow-up.
        const rows = serverId
          ? ((await fastify.db.execute(
              sql`SELECT slug, question, created_by, server_id, created_at, closed_at, allow_revote
                  FROM plugin_polls_polls
                  WHERE server_id = ${serverId}
                  ORDER BY created_at DESC
                  LIMIT 200`,
            )) as unknown as PollRow[])
          : ((await fastify.db.execute(
              sql`SELECT slug, question, created_by, server_id, created_at, closed_at, allow_revote
                  FROM plugin_polls_polls
                  WHERE created_by = ${request.actor.id}
                  ORDER BY created_at DESC
                  LIMIT 200`,
            )) as unknown as PollRow[]);
        return rows.map((r) => ({
          slug: r.slug,
          question: r.question,
          createdBy: r.created_by,
          createdAt: r.created_at,
          closedAt: r.closed_at,
        }));
      },
    );

    fastify.get<{ Params: { slug: string } }>('/polls/:slug', async (request, reply) => {
      const payload = await loadPoll(request.params.slug);
      if (!payload) return reply.status(404).send({ error: 'Poll not found' });
      if (request.actor) {
        const mine = (await fastify.db.execute(
          sql`SELECT option_id FROM plugin_polls_votes
              WHERE poll_id = (SELECT id FROM plugin_polls_polls WHERE slug = ${payload.slug})
                AND actor_uri = ${request.actor.uri}`,
        )) as unknown as { option_id: string }[];
        payload.myVoteOptionId = mine[0]?.option_id ?? null;
      }
      return payload;
    });

    fastify.post<{
      Params: { slug: string };
      Body: { optionId: string };
    }>('/polls/:slug/vote', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { slug } = request.params;
      const { optionId } = request.body ?? {};
      if (!optionId) return reply.status(400).send({ error: 'optionId is required' });
      const actorUri = request.actor.uri;
      const polls = (await fastify.db.execute(
        sql`SELECT id, closed_at, allow_revote FROM plugin_polls_polls WHERE slug = ${slug} LIMIT 1`,
      )) as unknown as { id: string; closed_at: string | null; allow_revote: boolean }[];
      const poll = polls[0];
      if (!poll) return reply.status(404).send({ error: 'Poll not found' });
      if (poll.closed_at) return reply.status(409).send({ error: 'Poll is closed' });
      const options = (await fastify.db.execute(
        sql`SELECT id FROM plugin_polls_options WHERE poll_id = ${poll.id} AND id = ${optionId} LIMIT 1`,
      )) as unknown as { id: string }[];
      if (options.length === 0) {
        return reply.status(400).send({ error: 'optionId does not belong to this poll' });
      }
      // Existing vote — reject if revote disabled, else update in place.
      const existing = (await fastify.db.execute(
        sql`SELECT option_id FROM plugin_polls_votes WHERE poll_id = ${poll.id} AND actor_uri = ${actorUri}`,
      )) as unknown as { option_id: string }[];
      if (existing.length > 0 && !poll.allow_revote) {
        return reply.status(409).send({ error: 'You have already voted; revoting is disabled' });
      }
      await fastify.db.execute(
        sql`INSERT INTO plugin_polls_votes (poll_id, actor_uri, option_id)
            VALUES (${poll.id}, ${actorUri}, ${optionId})
            ON CONFLICT (poll_id, actor_uri)
            DO UPDATE SET option_id = EXCLUDED.option_id, voted_at = NOW()`,
      );
      await broadcastPoll(slug);
      const payload = await loadPoll(slug);
      if (payload) payload.myVoteOptionId = optionId;
      return payload;
    });

    fastify.post<{ Params: { slug: string } }>(
      '/polls/:slug/close',
      async (request, reply) => {
        if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
        const polls = (await fastify.db.execute(
          sql`SELECT id, created_by FROM plugin_polls_polls WHERE slug = ${request.params.slug} LIMIT 1`,
        )) as unknown as { id: string; created_by: string }[];
        const poll = polls[0];
        if (!poll) return reply.status(404).send({ error: 'Poll not found' });
        if (poll.created_by !== request.actor.id) {
          return reply.status(403).send({ error: 'Only the creator can close a poll' });
        }
        await fastify.db.execute(
          sql`UPDATE plugin_polls_polls SET closed_at = NOW() WHERE id = ${poll.id}`,
        );
        await broadcastPoll(request.params.slug);
        return loadPoll(request.params.slug);
      },
    );
  },

  federationHandlers: {
    poll: {
      resolveBySlug: async (slug, ctx) => {
        const polls = (await ctx.fastify.db.execute(
          sql`SELECT * FROM plugin_polls_polls WHERE slug = ${slug} LIMIT 1`,
        )) as unknown as PollRow[];
        const poll = polls[0];
        if (!poll) return null;
        const options = (await ctx.fastify.db.execute(
          sql`SELECT o.id, o.position, o.label,
                     (SELECT COUNT(*) FROM plugin_polls_votes v WHERE v.option_id = o.id) AS vote_count
              FROM plugin_polls_options o
              WHERE o.poll_id = ${poll.id}
              ORDER BY o.position`,
        )) as unknown as Array<PollOptionRow & { vote_count: string }>;
        return {
          slug: poll.slug,
          question: poll.question,
          createdBy: poll.created_by,
          closedAt: poll.closed_at,
          allowRevote: poll.allow_revote,
          options: options.map((o) => ({
            id: o.id,
            position: o.position,
            label: o.label,
            voteCount: Number(o.vote_count),
          })),
          totalVotes: options.reduce((sum, o) => sum + Number(o.vote_count), 0),
        } satisfies PollPayload;
      },
    },
  },

  // setupClient lives in client-entry.ts. Keeping it out of the
  // manifest means server tsc never traces into JSX/bundler-style
  // client code. Client's registered.ts imports client-entry.ts
  // directly and calls setupClient after the manifest loads.
});

export type { PollPayload };
