// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, lt, desc } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { actors } from '../db/schema/actors.ts';
import type {
  ChannelView,
  MessageView,
  AuthorView,
  MessageWithAuthor,
  MessageListResponse,
  CreateMessageInput,
} from '@babelr/shared';

const DEFAULT_LIMIT = 50;

function toChannelView(obj: typeof objects.$inferSelect): ChannelView {
  const props = obj.properties as Record<string, unknown> | null;
  return {
    id: obj.id,
    name: (props?.name as string) ?? 'unnamed',
  };
}

function toMessageView(obj: typeof objects.$inferSelect): MessageView {
  return {
    id: obj.id,
    content: obj.content ?? '',
    channelId: obj.context ?? '',
    authorId: obj.attributedTo ?? '',
    published: obj.published.toISOString(),
  };
}

function toAuthorView(actor: typeof actors.$inferSelect): AuthorView {
  return {
    id: actor.id,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
  };
}

export default async function channelRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // List channels
  fastify.get('/channels', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const channels = await db
      .select()
      .from(objects)
      .where(eq(objects.type, 'OrderedCollection'));

    return channels.map(toChannelView);
  });

  // Get messages for a channel
  fastify.get<{
    Params: { channelId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/channels/:channelId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);
    const cursor = request.query.cursor;

    // Verify channel exists
    const [channel] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const conditions = [eq(objects.context, channelId), eq(objects.type, 'Note')];

    if (cursor) {
      conditions.push(lt(objects.published, new Date(cursor)));
    }

    const rows = await db
      .select({
        object: objects,
        actor: actors,
      })
      .from(objects)
      .innerJoin(actors, eq(objects.attributedTo, actors.id))
      .where(and(...conditions))
      .orderBy(desc(objects.published))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const messages: MessageWithAuthor[] = items.map((row) => ({
      message: toMessageView(row.object),
      author: toAuthorView(row.actor),
    }));

    const response: MessageListResponse = {
      messages,
      hasMore,
    };

    if (hasMore && items.length > 0) {
      response.cursor = items[items.length - 1].object.published.toISOString();
    }

    return response;
  });

  // Create a message in a channel
  fastify.post<{
    Params: { channelId: string };
    Body: CreateMessageInput;
  }>('/channels/:channelId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId } = request.params;
    const { content } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Message content is required' });
    }

    // Verify channel exists
    const [channel] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const actor = request.actor;

    // Insert Note object
    const [note] = await db
      .insert(objects)
      .values({
        uri: `${protocol}://${config.domain}/objects/${crypto.randomUUID()}`,
        type: 'Note',
        attributedTo: actor.id,
        content: content.trim(),
        context: channelId,
        to: [],
        cc: [],
      })
      .returning();

    // Insert Create activity
    await db.insert(activities).values({
      uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
      type: 'Create',
      actorId: actor.id,
      objectUri: note.uri,
      objectId: note.id,
      to: [],
      cc: [],
    });

    const messageView = toMessageView(note);
    const authorView = toAuthorView(actor);

    // Broadcast to WebSocket subscribers
    fastify.broadcastToChannel(channelId, {
      type: 'message:new',
      payload: { message: messageView, author: authorView },
    });

    return reply.status(201).send({ message: messageView, author: authorView });
  });
}
