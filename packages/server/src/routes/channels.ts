// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, lt, desc, gt, inArray } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { readPositions } from '../db/schema/read-positions.ts';
import { reactions } from '../db/schema/reactions.ts';
import { notificationPreferences } from '../db/schema/notification-preferences.ts';
import type {
  ChannelView,
  MessageView,
  AuthorView,
  MessageWithAuthor,
  MessageListResponse,
  CreateMessageInput,
  CreateChannelInput,
  WsServerMessage,
} from '@babelr/shared';
import { broadcastCreate, broadcastToGroupFollowers, enqueueToFollowers } from '../federation/delivery.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { serializeActivity, serializeNote } from '../federation/jsonld.ts';

const DEFAULT_LIMIT = 50;

// Parse @mentions from content and return array of mentioned usernames
function parseMentions(content: string): string[] {
  const mentions: Set<string> = new Set();
  const mentionRegex = /@(\w+)/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.add(match[1]);
  }
  return Array.from(mentions);
}

export function toChannelView(obj: typeof objects.$inferSelect): ChannelView {
  const props = obj.properties as Record<string, unknown> | null;
  return {
    id: obj.id,
    name: (props?.name as string) ?? 'unnamed',
    serverId: obj.belongsTo,
    ...(props?.category ? { category: props.category as string } : {}),
    ...(props?.isPrivate ? { isPrivate: true } : {}),
  };
}

export function toMessageView(obj: typeof objects.$inferSelect, reactionsData?: Record<string, string[]>): MessageView {
  const props = obj.properties as Record<string, unknown> | null;
  const messageProps: Record<string, unknown> = {};
  if (props?.encrypted) messageProps.encrypted = true;
  if (props?.iv) messageProps.iv = props.iv;
  if (props?.attachments) messageProps.attachments = props.attachments;

  return {
    id: obj.id,
    content: obj.content ?? '',
    channelId: obj.context ?? '',
    authorId: obj.attributedTo ?? '',
    published: obj.published.toISOString(),
    ...(obj.updated && obj.updated.getTime() !== obj.published.getTime() && { updated: obj.updated.toISOString() }),
    ...(Object.keys(messageProps).length > 0 && { properties: messageProps }),
    ...(reactionsData && { reactions: reactionsData }),
  };
}

export function toAuthorView(actor: typeof actors.$inferSelect): AuthorView {
  const props = actor.properties as Record<string, unknown> | null;
  return {
    id: actor.id,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    avatarUrl: (props?.avatarUrl as string) ?? null,
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

  // Load reactions for these messages
  const messageIds = items.map((row) => row.object.id);
  const reactionRows = messageIds.length > 0
    ? await db
        .select()
        .from(reactions)
        .where(inArray(reactions.objectId, messageIds))
    : [];

  // Group reactions by message → emoji → actor IDs
  const reactionsByMessage = new Map<string, Record<string, string[]>>();
  for (const r of reactionRows) {
    const msgReactions = reactionsByMessage.get(r.objectId) ?? {};
    const list = msgReactions[r.emoji] ?? [];
    list.push(r.actorId);
    msgReactions[r.emoji] = list;
    reactionsByMessage.set(r.objectId, msgReactions);
  }

  const messages: MessageWithAuthor[] = items.map((row) => ({
    message: toMessageView(row.object, reactionsByMessage.get(row.object.id)),
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

  // Parse mentions from content
  const mentionedUsernames = parseMentions(content);

  // Look up mentioned actors
  const mentionedActors = mentionedUsernames.length > 0
    ? await db
        .select({ id: actors.id })
        .from(actors)
        .where(inArray(actors.preferredUsername, mentionedUsernames))
    : [];

  const mentionedIds = mentionedActors.map((a) => a.id);

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
      properties: {
        ...messageProperties,
        ...(mentionedIds.length > 0 && { mentions: mentionedIds }),
      },
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
export async function checkChannelAccess(
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

  if (!membership) return { allowed: false, channel };

  // For private channels, also check channel-level membership
  const props = channel.properties as Record<string, unknown> | null;
  if (props?.isPrivate) {
    const [channelMembership] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, channel.uri),
          eq(collectionItems.itemUri, actorUri),
        ),
      )
      .limit(1);
    return { allowed: !!channelMembership, channel };
  }

  return { allowed: true, channel };
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

      // Filter out private channels the user isn't a member of
      const visible = [];
      for (const ch of channels) {
        const props = ch.properties as Record<string, unknown> | null;
        if (props?.isPrivate) {
          const [membership] = await db
            .select({ id: collectionItems.id })
            .from(collectionItems)
            .where(and(eq(collectionItems.collectionUri, ch.uri), eq(collectionItems.itemUri, request.actor!.uri)))
            .limit(1);
          if (membership) visible.push(ch);
        } else {
          visible.push(ch);
        }
      }

      return visible.map(toChannelView);
    },
  );

  // Create channel in a server
  fastify.post<{ Params: { serverId: string }; Body: CreateChannelInput }>(
    '/servers/:serverId/channels',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { name, category, isPrivate } = request.body;
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
          properties: {
            name: name.trim(),
            ...(category ? { category: category.trim() } : {}),
            ...(isPrivate ? { isPrivate: true } : {}),
          },
        })
        .returning();

      // For private channels, add creator as member
      if (isPrivate && request.actor) {
        await db.insert(collectionItems).values({
          collectionUri: channel.uri,
          collectionId: channel.id,
          itemUri: request.actor.uri,
          itemId: request.actor.id,
        });
      }

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

  // Get unread count for a channel
  fastify.get<{ Params: { channelId: string } }>(
    '/channels/:channelId/unread',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { channelId } = request.params;

      // Check channel exists
      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      // Get read position for this actor
      const [readPosition] = await db
        .select()
        .from(readPositions)
        .where(and(eq(readPositions.actorId, request.actor.id), eq(readPositions.channelId, channelId)))
        .limit(1);

      // Count messages after read position (or all messages if never read)
      const conditions = [eq(objects.context, channelId), eq(objects.type, 'Note')];
      if (readPosition) {
        conditions.push(gt(objects.published, readPosition.lastReadAt));
      }

      const unreadMessages = await db
        .select({ id: objects.id })
        .from(objects)
        .where(and(...conditions));

      return { count: unreadMessages.length };
    },
  );

  // Mark channel as read
  fastify.put<{ Params: { channelId: string } }>(
    '/channels/:channelId/read',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { channelId } = request.params;
      const now = new Date();

      // Check channel exists
      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      // Upsert read position
      const [existing] = await db
        .select()
        .from(readPositions)
        .where(and(eq(readPositions.actorId, request.actor.id), eq(readPositions.channelId, channelId)))
        .limit(1);

      if (existing) {
        await db
          .update(readPositions)
          .set({ lastReadAt: now })
          .where(eq(readPositions.id, existing.id));
      } else {
        await db.insert(readPositions).values({
          actorId: request.actor.id,
          channelId,
          lastReadAt: now,
        });
      }

      return { ok: true };
    },
  );

  // Add emoji reaction
  fastify.post<{
    Params: { channelId: string; messageId: string };
    Body: { emoji: string };
  }>('/channels/:channelId/messages/:messageId/reactions', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId, messageId } = request.params;
    const { emoji } = request.body;

    if (!emoji || emoji.trim().length === 0) {
      return reply.status(400).send({ error: 'Emoji is required' });
    }

    // Check channel access
    const { allowed } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });

    // Check message exists
    const [message] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
      .limit(1);

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' });
    }

    // Check if reaction already exists
    const [existing] = await db
      .select()
      .from(reactions)
      .where(
        and(
          eq(reactions.objectId, messageId),
          eq(reactions.actorId, request.actor.id),
          eq(reactions.emoji, emoji),
        ),
      )
      .limit(1);

    if (existing) {
      return reply.status(400).send({ error: 'Already reacted with this emoji' });
    }

    // Add reaction
    await db.insert(reactions).values({
      objectId: messageId,
      actorId: request.actor.id,
      emoji,
    });

    // Broadcast reaction
    const reactionMsg: WsServerMessage = {
      type: 'reaction:add',
      payload: {
        messageId,
        emoji,
        actor: toAuthorView(request.actor),
      },
    };
    fastify.broadcastToChannel(channelId, reactionMsg);

    return { ok: true };
  });

  // Remove emoji reaction
  fastify.delete<{
    Params: { channelId: string; messageId: string };
    Querystring: { emoji?: string };
  }>('/channels/:channelId/messages/:messageId/reactions', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId, messageId } = request.params;
    const { emoji } = request.query;

    if (!emoji) {
      return reply.status(400).send({ error: 'Emoji is required' });
    }

    // Check channel access
    const { allowed: canAccess } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!canAccess) return reply.status(403).send({ error: 'Not a member of this channel' });

    // Check message exists
    const [message] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
      .limit(1);

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' });
    }

    // Remove reaction
    await db
      .delete(reactions)
      .where(
        and(
          eq(reactions.objectId, messageId),
          eq(reactions.actorId, request.actor.id),
          eq(reactions.emoji, emoji),
        ),
      );

    // Broadcast removal
    const reactionMsg: WsServerMessage = {
      type: 'reaction:remove',
      payload: {
        messageId,
        emoji,
        actorId: request.actor.id,
      },
    };
    fastify.broadcastToChannel(channelId, reactionMsg);

    return { ok: true };
  });

  // Get messages mentioning current actor
  fastify.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/mentions',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);

      const conditions = [eq(objects.type, 'Note')];

      const rows = await db
        .select({ object: objects, actor: actors })
        .from(objects)
        .innerJoin(actors, eq(objects.attributedTo, actors.id))
        .where(and(...conditions))
        .orderBy(desc(objects.published))
        .limit(limit + 1);

      // Filter for messages that mention the current actor
      const messages: MessageWithAuthor[] = rows
        .map((row) => ({
          message: toMessageView(row.object),
          author: toAuthorView(row.actor),
        }))
        .filter((item) => {
          const props = (item.message.properties as Record<string, unknown>) ?? {};
          const mentions = (props.mentions as string[]) ?? [];
          return mentions.includes(request.actor!.id);
        });

      const hasMore = rows.length > limit;
      const response: MessageListResponse = {
        messages: messages.slice(0, limit),
        hasMore,
      };
      if (hasMore && messages.length > 0) {
        response.cursor = messages[Math.min(limit - 1, messages.length - 1)].message.published;
      }
      return response;
    },
  );

  // Get replies/thread for a message
  fastify.get<{ Params: { channelId: string; messageId: string } }>(
    '/channels/:channelId/messages/:messageId/replies',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { channelId, messageId } = request.params;

      // Check parent message exists
      const [parentMessage] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
        .limit(1);

      if (!parentMessage) {
        return reply.status(404).send({ error: 'Message not found' });
      }

      // Get all replies to this message
      const rows = await db
        .select({ object: objects, actor: actors })
        .from(objects)
        .innerJoin(actors, eq(objects.attributedTo, actors.id))
        .where(
          and(eq(objects.inReplyTo, messageId), eq(objects.type, 'Note')),
        )
        .orderBy(desc(objects.published));

      const messages: MessageWithAuthor[] = rows.map((row) => ({
        message: toMessageView(row.object),
        author: toAuthorView(row.actor),
      }));

      return { messages, hasMore: false };
    },
  );

  // Create a reply to a message
  fastify.post<{
    Params: { channelId: string; messageId: string };
    Body: CreateMessageInput;
  }>('/channels/:channelId/messages/:messageId/replies', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { channelId, messageId } = request.params;
    const { content } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Message content is required' });
    }

    // Check parent message exists
    const [parentMessage] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')))
      .limit(1);

    if (!parentMessage) {
      return reply.status(404).send({ error: 'Message not found' });
    }

    const { allowed } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this server' });

    // Parse mentions
    const mentionedUsernames = parseMentions(content);
    const mentionedActors = mentionedUsernames.length > 0
      ? await db
          .select({ id: actors.id })
          .from(actors)
          .where(inArray(actors.preferredUsername, mentionedUsernames))
      : [];
    const mentionedIds = mentionedActors.map((a) => a.id);

    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';

    const [reply_msg] = await db
      .insert(objects)
      .values({
        uri: `${protocol}://${config.domain}/objects/${crypto.randomUUID()}`,
        type: 'Note',
        attributedTo: request.actor.id,
        content: content.trim(),
        context: channelId,
        inReplyTo: messageId,
        to: [],
        cc: [],
        properties: mentionedIds.length > 0 ? { mentions: mentionedIds } : {},
      })
      .returning();

    await db.insert(activities).values({
      uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
      type: 'Create',
      actorId: request.actor.id,
      objectUri: reply_msg.uri,
      objectId: reply_msg.id,
      to: [],
      cc: [],
    });

    const messageView = toMessageView(reply_msg);
    const authorView = toAuthorView(request.actor);

    // Broadcast as regular message (client filters by inReplyTo for thread view)
    fastify.broadcastToChannel(channelId, {
      type: 'message:new',
      payload: { message: messageView, author: authorView },
    });

    return reply.status(201).send({ message: messageView, author: authorView });
  });

  // Get channel glossary
  fastify.get<{ Params: { channelId: string } }>(
    '/channels/:channelId/glossary',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, request.params.channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) return reply.status(404).send({ error: 'Channel not found' });

      const props = channel.properties as Record<string, unknown> | null;
      return { glossary: (props?.glossary as Record<string, string>) ?? {} };
    },
  );

  // Update channel glossary
  fastify.put<{ Params: { channelId: string }; Body: { glossary: Record<string, string> } }>(
    '/channels/:channelId/glossary',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const { channelId } = request.params;
      const { glossary } = request.body;

      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) return reply.status(404).send({ error: 'Channel not found' });

      const props = (channel.properties as Record<string, unknown>) ?? {};
      await db
        .update(objects)
        .set({ properties: { ...props, glossary } })
        .where(eq(objects.id, channelId));

      return { ok: true };
    },
  );

  // Invite user to private channel
  fastify.post<{ Params: { channelId: string }; Body: { userId: string } }>(
    '/channels/:channelId/invite',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const { channelId } = request.params;
      const { userId } = request.body;

      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) return reply.status(404).send({ error: 'Channel not found' });

      const props = channel.properties as Record<string, unknown> | null;
      if (!props?.isPrivate) {
        return reply.status(400).send({ error: 'Channel is not private' });
      }

      const [user] = await db.select().from(actors).where(eq(actors.id, userId)).limit(1);
      if (!user) return reply.status(404).send({ error: 'User not found' });

      await db
        .insert(collectionItems)
        .values({
          collectionUri: channel.uri,
          collectionId: channel.id,
          itemUri: user.uri,
          itemId: user.id,
        })
        .onConflictDoNothing();

      return { ok: true };
    },
  );

  // Get notification preferences
  fastify.get('/notifications/preferences', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const prefs = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.actorId, request.actor.id));

    const mutedMap: Record<string, boolean> = {};
    for (const p of prefs) {
      if (p.muted) mutedMap[p.targetId] = true;
    }
    return { muted: mutedMap };
  });

  // Set mute preference
  fastify.put<{ Body: { targetId: string; targetType: string; muted: boolean } }>(
    '/notifications/preferences',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const { targetId, targetType, muted } = request.body;

      const [existing] = await db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.actorId, request.actor.id),
            eq(notificationPreferences.targetId, targetId),
          ),
        )
        .limit(1);

      if (existing) {
        await db
          .update(notificationPreferences)
          .set({ muted })
          .where(eq(notificationPreferences.id, existing.id));
      } else {
        await db.insert(notificationPreferences).values({
          actorId: request.actor.id,
          targetId,
          targetType,
          muted,
        });
      }

      return { ok: true };
    },
  );
}
