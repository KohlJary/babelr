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
import { broadcastCreate, broadcastToGroupFollowers, enqueueToFollowers } from '../federation/delivery.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { serializeActivity, serializeNote } from '../federation/jsonld.ts';

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
  const props = obj.properties as Record<string, unknown> | null;
  const messageProps: Record<string, unknown> = {};
  if (props?.encrypted) messageProps.encrypted = true;
  if (props?.iv) messageProps.iv = props.iv;

  return {
    id: obj.id,
    content: obj.content ?? '',
    channelId: obj.context ?? '',
    authorId: obj.attributedTo ?? '',
    published: obj.published.toISOString(),
    ...(Object.keys(messageProps).length > 0 && { properties: messageProps }),
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
  messageProperties?: Record<string, unknown>,
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
      ...(messageProperties && { properties: messageProperties }),
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

  // Federation: enqueue delivery to remote followers (public channels only)
  if (!messageProperties?.encrypted && actor.local) {
    ensureActorKeys(db, actor)
      .then((actorWithKeys) => broadcastCreate(fastify, note, actorWithKeys))
      .catch((err) => fastify.log.error(err, 'Federation enqueue failed'));

    // Also deliver to Group followers if channel belongs to a server
    if (note.context) {
      const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group) {
          ensureActorKeys(db, group)
            .then((groupWithKeys) => broadcastToGroupFollowers(fastify, note, actor, groupWithKeys))
            .catch((err) => fastify.log.error(err, 'Group federation enqueue failed'));
        }
      }
    }
  }

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

async function getMemberRole(
  db: ReturnType<typeof import('../db/index.ts').createDb>,
  serverFollowersUri: string,
  actorUri: string,
): Promise<string | null> {
  const [membership] = await db
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, serverFollowersUri),
        eq(collectionItems.itemUri, actorUri),
      ),
    )
    .limit(1);

  if (!membership) return null;
  const props = membership.properties as Record<string, unknown> | null;
  return (props?.role as string) ?? 'member';
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

  // Edit a message
  fastify.put<{
    Params: { channelId: string; messageId: string };
    Body: { content: string };
  }>('/channels/:channelId/messages/:messageId', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId, messageId } = request.params;
    const { content } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Message content is required' });
    }

    const [message] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
      .limit(1);

    if (!message) return reply.status(404).send({ error: 'Message not found' });
    if (message.attributedTo !== request.actor.id) {
      return reply.status(403).send({ error: 'Can only edit your own messages' });
    }

    const [updated] = await db
      .update(objects)
      .set({ content: content.trim(), updated: new Date() })
      .where(eq(objects.id, messageId))
      .returning();

    // Create Update activity and enqueue federation delivery
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const actor = request.actor;

    await db.insert(activities).values({
      uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
      type: 'Update',
      actorId: actor.id,
      objectUri: updated.uri,
      objectId: updated.id,
    });

    if (actor.local) {
      const noteJson = serializeNote(updated, actor.uri);
      const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
      const activity = serializeActivity(activityUri, 'Update', actor.uri, noteJson, ['https://www.w3.org/ns/activitystreams#Public'], []);

      ensureActorKeys(db, actor)
        .then((actorWithKeys) => enqueueToFollowers(fastify, actorWithKeys, activity))
        .catch((err) => fastify.log.error(err, 'Update federation enqueue failed'));
    }

    return toMessageView(updated);
  });

  // Delete a message
  fastify.delete<{
    Params: { channelId: string; messageId: string };
  }>('/channels/:channelId/messages/:messageId', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId, messageId } = request.params;

    const [message] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
      .limit(1);

    if (!message) return reply.status(404).send({ error: 'Message not found' });

    // Allow delete if: author OR server admin/moderator/owner
    let canDelete = message.attributedTo === request.actor.id;
    if (!canDelete) {
      const { channel: ch } = await checkChannelAccess(db, channelId, request.actor.uri);
      if (ch?.belongsTo) {
        const [server] = await db.select().from(actors).where(eq(actors.id, ch.belongsTo)).limit(1);
        if (server?.followersUri) {
          const role = await getMemberRole(db, server.followersUri, request.actor.uri);
          canDelete = ['owner', 'admin', 'moderator'].includes(role ?? '');
        }
      }
    }
    if (!canDelete) {
      return reply.status(403).send({ error: 'Insufficient permissions to delete this message' });
    }

    // Tombstone the message
    await db
      .update(objects)
      .set({ type: 'Tombstone', content: null, updated: new Date() })
      .where(eq(objects.id, messageId));

    // Create Delete activity and enqueue federation delivery
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const actor = request.actor;

    await db.insert(activities).values({
      uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
      type: 'Delete',
      actorId: actor.id,
      objectUri: message.uri,
      objectId: message.id,
    });

    if (actor.local) {
      const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
      const activity = serializeActivity(activityUri, 'Delete', actor.uri, message.uri, ['https://www.w3.org/ns/activitystreams#Public'], []);

      ensureActorKeys(db, actor)
        .then((actorWithKeys) => enqueueToFollowers(fastify, actorWithKeys, activity))
        .catch((err) => fastify.log.error(err, 'Delete federation enqueue failed'));
    }

    return { ok: true };
  });
}
