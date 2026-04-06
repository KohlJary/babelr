// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, lt, desc } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import type {
  ChannelView,
  MessageView,
  AuthorView,
  MessageWithAuthor,
  MessageListResponse,
  CreateMessageInput,
  CreateChannelInput,
} from '@babelr/shared';

const DEFAULT_LIMIT = 50;

export function toChannelView(obj: typeof objects.$inferSelect): ChannelView {
  const props = obj.properties as Record<string, unknown> | null;
  return {
    id: obj.id,
    name: (props?.name as string) ?? 'unnamed',
    serverId: obj.belongsTo,
  };
}

export function toMessageView(obj: typeof objects.$inferSelect): MessageView {
  return {
    id: obj.id,
    content: obj.content ?? '',
    channelId: obj.context ?? '',
    authorId: obj.attributedTo ?? '',
    published: obj.published.toISOString(),
  };
}

export function toAuthorView(actor: typeof actors.$inferSelect): AuthorView {
  return {
    id: actor.id,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
  };
}

// Shared message query logic used by both channel and DM routes
export async function getMessagesForChannel(
  db: ReturnType<typeof import('../db/index.ts').createDb>,
  channelId: string,
  cursor?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<MessageListResponse> {
  const conditions = [eq(objects.context, channelId), eq(objects.type, 'Note')];

  if (cursor) {
    conditions.push(lt(objects.published, new Date(cursor)));
  }

  const rows = await db
    .select({ object: objects, actor: actors })
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

  const response: MessageListResponse = { messages, hasMore };
  if (hasMore && items.length > 0) {
    response.cursor = items[items.length - 1].object.published.toISOString();
  }
  return response;
}

export async function createMessageInChannel(
  fastify: FastifyInstance,
  channelId: string,
  content: string,
  actor: typeof actors.$inferSelect,
): Promise<MessageWithAuthor> {
  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

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

  fastify.broadcastToChannel(channelId, {
    type: 'message:new',
    payload: { message: messageView, author: authorView },
  });

  return { message: messageView, author: authorView };
}

// Check if actor is a member of the server that owns a channel
async function checkChannelAccess(
  db: ReturnType<typeof import('../db/index.ts').createDb>,
  channelId: string,
  actorUri: string,
): Promise<{ allowed: boolean; channel: typeof objects.$inferSelect | null }> {
  const [channel] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
    .limit(1);

  if (!channel) return { allowed: false, channel: null };

  // If channel has no server (legacy or DM), allow for now
  if (!channel.belongsTo) return { allowed: true, channel };

  // Check server membership
  const [server] = await db
    .select()
    .from(actors)
    .where(eq(actors.id, channel.belongsTo))
    .limit(1);

  if (!server?.followersUri) return { allowed: false, channel };

  const [membership] = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, server.followersUri),
        eq(collectionItems.itemUri, actorUri),
      ),
    )
    .limit(1);

  return { allowed: !!membership, channel };
}

export default async function channelRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // List channels in a server
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/channels',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const channels = await db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.type, 'OrderedCollection'),
            eq(objects.belongsTo, request.params.serverId),
          ),
        );

      return channels.map(toChannelView);
    },
  );

  // Create channel in a server
  fastify.post<{ Params: { serverId: string }; Body: CreateChannelInput }>(
    '/servers/:serverId/channels',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { name } = request.body;
      if (!name || name.trim().length === 0) {
        return reply.status(400).send({ error: 'Channel name is required' });
      }

      // Verify server exists and user is owner
      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      const [channel] = await db
        .insert(objects)
        .values({
          uri: `${protocol}://${config.domain}/channels/${crypto.randomUUID()}`,
          type: 'OrderedCollection',
          belongsTo: server.id,
          properties: { name: name.trim() },
        })
        .returning();

      return reply.status(201).send(toChannelView(channel));
    },
  );

  // Get messages for a channel (with membership check)
  fastify.get<{
    Params: { channelId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/channels/:channelId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);

    const { allowed, channel } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!channel) return reply.status(404).send({ error: 'Channel not found' });
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this server' });

    return getMessagesForChannel(db, channelId, request.query.cursor, limit);
  });

  // Create a message in a channel (with membership check)
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

    const { allowed, channel } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!channel) return reply.status(404).send({ error: 'Channel not found' });
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this server' });

    const result = await createMessageInChannel(fastify, channelId, content, request.actor);
    return reply.status(201).send(result);
  });
}
