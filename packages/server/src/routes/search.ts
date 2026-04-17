// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import type { MessageListResponse, MessageWithAuthor } from '@babelr/shared';
import { toMessageView, toAuthorView, checkChannelAccess } from '../serializers.ts';

const DEFAULT_LIMIT = 50;

export default async function searchRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // Search messages
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

    const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);

    const searchQuery = q.trim().split(/\s+/).join(' & ');
    const conditions = [
      eq(objects.type, 'Note'),
      sql`${objects.contentSearch} @@ to_tsquery('english', ${searchQuery})`,
    ];

    if (channelId) {
      const { allowed } = await checkChannelAccess(db, channelId, request.actor!.uri);
      if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });
      conditions.push(eq(objects.context, channelId));
    }

    const rows = await db
      .select({
        object: objects,
        actor: actors,
        rank: sql`ts_rank(${objects.contentSearch}, to_tsquery('english', ${searchQuery}))`,
      })
      .from(objects)
      .innerJoin(actors, eq(objects.attributedTo, actors.id))
      .where(and(...conditions))
      .orderBy(sql`ts_rank DESC`)
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
    return response;
  });
}
