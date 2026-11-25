// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { eq, and, sql, lt, gt, desc } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import type { MessageListResponse, MessageWithAuthor } from '@babelr/shared';
import { toMessageView, toAuthorView, checkChannelAccess } from '../serializers.ts';

const DEFAULT_LIMIT = 50;

interface ParsedFilters {
  textQuery: string;
  from?: string;
  channelName?: string;
  before?: Date;
  after?: Date;
  has?: string[];
}

/**
 * Parse filter operators out of a search query string.
 *   from:alice     → messages by user "alice"
 *   in:general     → messages in channel "general"
 *   before:2026-04-01 → messages before this date
 *   after:2026-03-01  → messages after this date
 *   has:file       → messages with attachments
 *   has:link       → messages containing URLs
 *   has:image      → messages with image attachments
 */
function parseFilters(raw: string): ParsedFilters {
  const tokens = raw.split(/\s+/);
  const textTokens: string[] = [];
  const filters: ParsedFilters = { textQuery: '' };
  const hasFilters: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('from:')) {
      filters.from = token.slice(5).replace(/^@/, '');
    } else if (lower.startsWith('in:')) {
      filters.channelName = token.slice(3).replace(/^#/, '');
    } else if (lower.startsWith('before:')) {
      const d = new Date(token.slice(7));
      if (!isNaN(d.getTime())) filters.before = d;
    } else if (lower.startsWith('after:')) {
      const d = new Date(token.slice(6));
      if (!isNaN(d.getTime())) filters.after = d;
    } else if (lower.startsWith('has:')) {
      hasFilters.push(token.slice(4).toLowerCase());
    } else {
      textTokens.push(token);
    }
  }

  filters.textQuery = textTokens.join(' ');
  if (hasFilters.length > 0) filters.has = hasFilters;
  return filters;
}

export default async function searchRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get<{
    Querystring: { q?: string; channelId?: string; cursor?: string; limit?: string };
  }>('/search', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { q, channelId } = request.query;
    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: 'Search query is required' });
    }

    const limit = Math.min(parseInt(request.query.limit ?? '', 10) || DEFAULT_LIMIT, 100);
    const filters = parseFilters(q.trim());

    const actorUri = request.actor.uri;

    // Only server channels the searcher can read: a member of the server,
    // and for a private channel a member of the channel too (the same rule
    // as checkChannelAccess). DMs are left out on purpose: they are E2E
    // encrypted, so the server only holds ciphertext for them. Before this,
    // a search without channelId ran over every Note on the instance.
    const readableChannelIds = sql`(
      SELECT ch.id FROM objects ch
      JOIN actors srv ON srv.id = ch.belongs_to
      JOIN collection_items mem
        ON mem.collection_uri = srv.followers_uri AND mem.item_uri = ${actorUri}
      WHERE ch.type = 'OrderedCollection'
        AND (
          COALESCE((ch.properties->>'isPrivate')::boolean, false) = false
          OR EXISTS (
            SELECT 1 FROM collection_items cm
            WHERE cm.collection_uri = ch.uri AND cm.item_uri = ${actorUri}
          )
        )
    )`;

    const conditions = [
      eq(objects.type, 'Note'),
      sql`${objects.context} IN ${readableChannelIds}`,
      // Belt and braces: never match on ciphertext.
      sql`COALESCE((${objects.properties}->>'encrypted')::boolean, false) = false`,
    ];

    // Full-text search on the remaining text (after filters are removed).
    // objects.content_search is never populated, so build the vector from
    // the content here; websearch_to_tsquery takes free text without
    // throwing on punctuation the way to_tsquery did.
    const tsVector = sql`to_tsvector('english', COALESCE(${objects.content}, ''))`;
    const tsQuery = sql`websearch_to_tsquery('english', ${filters.textQuery})`;
    if (filters.textQuery.length > 0) {
      conditions.push(sql`${tsVector} @@ ${tsQuery}`);
    }

    // Channel filter: by ID (existing param) or by name (in: operator)
    if (channelId) {
      const { allowed, channel } = await checkChannelAccess(db, channelId, actorUri);
      if (!channel) return reply.status(404).send({ error: 'Channel not found' });
      if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });
      conditions.push(eq(objects.context, channelId));
    } else if (filters.channelName) {
      // By name, among the channels the searcher can read
      conditions.push(
        sql`${objects.context} IN (
          SELECT id FROM objects
          WHERE id IN ${readableChannelIds}
            AND (properties->>'name') ILIKE ${filters.channelName}
        )`,
      );
    }

    // Author filter
    if (filters.from) {
      const [author] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.preferredUsername, filters.from))
        .limit(1);
      if (author) {
        conditions.push(eq(objects.attributedTo, author.id));
      } else {
        return { messages: [], hasMore: false };
      }
    }

    // Date filters
    if (filters.before) {
      conditions.push(lt(objects.published, filters.before));
    }
    if (filters.after) {
      conditions.push(gt(objects.published, filters.after));
    }

    // has: filters
    if (filters.has) {
      for (const h of filters.has) {
        if (h === 'file' || h === 'attachment') {
          conditions.push(sql`(${objects.properties}->>'attachments') IS NOT NULL`);
        } else if (h === 'link' || h === 'url') {
          conditions.push(sql`${objects.content} ~* 'https?://'`);
        } else if (h === 'image') {
          conditions.push(sql`(${objects.properties}->>'attachments')::text LIKE '%image%'`);
        }
      }
    }

    // Rank if there's a text query, otherwise newest first
    const hasTextQuery = filters.textQuery.length > 0;

    const rows = await db
      .select({ object: objects, actor: actors })
      .from(objects)
      .innerJoin(actors, eq(objects.attributedTo, actors.id))
      .where(and(...conditions))
      .orderBy(
        ...(hasTextQuery
          ? [sql`ts_rank(${tsVector}, ${tsQuery}) DESC`, desc(objects.published)]
          : [desc(objects.published)]),
      )
      .limit(limit + 1);

    const messages: MessageWithAuthor[] = rows.map((row) => ({
      message: toMessageView(row.object),
      author: toAuthorView(row.actor),
    }));

    const hasMore = messages.length > limit;
    const response: MessageListResponse = {
      messages: messages.slice(0, limit),
      hasMore,
    };
    if (hasMore && messages.length > 0) {
      response.cursor = messages[limit - 1].message.published;
    }

    // Return active filters so the client can display filter pills
    return {
      ...response,
      filters: {
        text: filters.textQuery || undefined,
        from: filters.from,
        channel: filters.channelName,
        before: filters.before?.toISOString(),
        after: filters.after?.toISOString(),
        has: filters.has,
      },
    };
  });
}
