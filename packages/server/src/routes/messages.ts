// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, inArray } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { actors } from '../db/schema/actors.ts';
import { reactions } from '../db/schema/reactions.ts';
import type {
  MessageWithAuthor,
  MessageListResponse,
  CreateMessageInput,
  WsServerMessage,
} from '@babelr/shared';
import { broadcastCreate, broadcastToGroupFollowers, enqueueToFollowers, enqueueDelivery } from '../federation/delivery.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { serializeActivity, serializeNote } from '../federation/jsonld.ts';
import { syncMessageOutboundLinks } from '../wiki-link-sync.ts';
import { PERMISSIONS, isValidMessageSlug } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { signedGet } from '../federation/delivery.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { createMessageInChannel, parseMentions } from './channels.ts';
import {
  toMessageView,
  toAuthorView,
  getMessagesForChannel,
  checkChannelAccess,
} from '../serializers.ts';

const DEFAULT_LIMIT = 50;

export default async function messageRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

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
    const { content, properties } = request.body;

    const hasAttachments = properties?.attachments && Array.isArray(properties.attachments) && properties.attachments.length > 0;
    if ((!content || content.trim().length === 0) && !hasAttachments) {
      return reply.status(400).send({ error: 'Message content or attachment is required' });
    }

    const { allowed, channel } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!channel) return reply.status(404).send({ error: 'Channel not found' });
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this server' });

    // SEND_MESSAGES permission check — only for server-scoped channels.
    // DMs and other non-server channels aren't gated on role permissions.
    // Default role permissions grant SEND_MESSAGES to @everyone so
    // existing behavior is unchanged, but admins can now revoke it to
    // create read-only channels or temporarily mute a member via role.
    if (channel.belongsTo) {
      if (
        !(await hasPermission(db, channel.belongsTo, request.actor.id, PERMISSIONS.SEND_MESSAGES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions to send messages' });
      }
    }

    // ATTACH_FILES permission — only checked when the message includes
    // attachments. Default role grants this to @everyone.
    if (hasAttachments && channel.belongsTo) {
      if (
        !(await hasPermission(db, channel.belongsTo, request.actor.id, PERMISSIONS.ATTACH_FILES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions to attach files' });
      }
    }

    // Slow mode enforcement — bypassed for users with MANAGE_CHANNELS.
    // We reuse MANAGE_CHANNELS rather than adding a dedicated
    // BYPASS_SLOWMODE permission — anyone who can edit channel
    // settings can also bypass the rate limit, and that's a
    // reasonable intuition for server operators.
    const channelProps = channel.properties as Record<string, unknown> | null;
    const slowMode = typeof channelProps?.slowMode === 'number' ? (channelProps.slowMode as number) : 0;
    if (slowMode > 0 && channel.belongsTo) {
      const bypassSlowMode = await hasPermission(
        db,
        channel.belongsTo,
        request.actor.id,
        PERMISSIONS.MANAGE_CHANNELS,
      );

      if (!bypassSlowMode) {
        const [lastOwn] = await db
          .select()
          .from(objects)
          .where(
            and(
              eq(objects.context, channelId),
              eq(objects.type, 'Note'),
              eq(objects.attributedTo, request.actor.id),
            ),
          )
          .orderBy(desc(objects.published))
          .limit(1);

        if (lastOwn) {
          const ageMs = Date.now() - lastOwn.published.getTime();
          const remainingMs = slowMode * 1000 - ageMs;
          if (remainingMs > 0) {
            return reply
              .status(429)
              .send({
                error: 'Slow mode',
                message: `Please wait ${Math.ceil(remainingMs / 1000)}s before sending another message.`,
                retryAfter: Math.ceil(remainingMs / 1000),
              });
          }
        }
      }
    }

    const result = await createMessageInChannel(fastify, channelId, content, request.actor, properties);
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

    // Re-sync [[slug]] wiki refs after edit
    await syncMessageOutboundLinks(db, updated.id, channelId, updated.content ?? '');

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

    // Broadcast the edit to all local WS subscribers so other
    // viewers in the channel see the update in real time.
    fastify.broadcastToChannel(channelId, {
      type: 'message:updated',
      payload: {
        messageId: updated.id,
        channelId,
        content: updated.content ?? '',
        updatedAt: (updated.updated ?? new Date()).toISOString(),
      },
    });

    if (actor.local) {
      // Resolve context + inReplyTo URIs for the serialized Note.
      let contextUri: string | undefined;
      const [ch] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, channelId)).limit(1);
      if (ch) contextUri = ch.uri;
      let inReplyToUri: string | undefined;
      if (updated.inReplyTo) {
        const [parent] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, updated.inReplyTo)).limit(1);
        if (parent) inReplyToUri = parent.uri;
      }

      const noteJson = serializeNote(updated, actor.uri, contextUri, inReplyToUri);
      const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

      const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group && !group.local && group.inboxUri) {
          // Remote server: deliver to the origin Group's inbox.
          const activity = serializeActivity(activityUri, 'Update', actor.uri, noteJson, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, actor)
            .then((actorWithKeys) => enqueueDelivery(db, activity, group.inboxUri!, actorWithKeys.id))
            .catch((err) => fastify.log.error(err, 'Remote update delivery failed'));
        } else if (group) {
          // Local server: fan out via Group to remote followers.
          const activity = serializeActivity(activityUri, 'Update', group.uri, noteJson, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, group)
            .then((groupWithKeys) => enqueueToFollowers(fastify, groupWithKeys, activity))
            .catch((err) => fastify.log.error(err, 'Update federation enqueue failed'));
        }
      }
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

    // Allow delete if: author (creator-override, always) OR has
    // MANAGE_MESSAGES permission on the owning server (non-author case).
    let canDelete = message.attributedTo === request.actor.id;
    if (!canDelete) {
      const { channel: ch } = await checkChannelAccess(db, channelId, request.actor.uri);
      if (ch?.belongsTo) {
        canDelete = await hasPermission(
          db,
          ch.belongsTo,
          request.actor.id,
          PERMISSIONS.MANAGE_MESSAGES,
        );
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

    // Broadcast deletion to all local WS subscribers.
    fastify.broadcastToChannel(channelId, {
      type: 'message:deleted',
      payload: { messageId, channelId },
    });

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

      const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group && !group.local && group.inboxUri) {
          // Remote server: deliver to the origin Group's inbox.
          const activity = serializeActivity(activityUri, 'Delete', actor.uri, message.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, actor)
            .then((actorWithKeys) => enqueueDelivery(db, activity, group.inboxUri!, actorWithKeys.id))
            .catch((err) => fastify.log.error(err, 'Remote delete delivery failed'));
        } else if (group) {
          // Local server: fan out via Group to remote followers.
          const activity = serializeActivity(activityUri, 'Delete', group.uri, message.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, group)
            .then((groupWithKeys) => enqueueToFollowers(fastify, groupWithKeys, activity))
            .catch((err) => fastify.log.error(err, 'Delete federation enqueue failed'));
        }
      }
    }

    return { ok: true };
  });

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
    const { allowed, channel } = await checkChannelAccess(db, channelId, request.actor.uri);
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });

    // ADD_REACTIONS permission check — server-scoped channels only.
    // @everyone has this by default so existing behavior is unchanged;
    // admins can now revoke it via role to restrict reactions.
    if (channel?.belongsTo) {
      if (
        !(await hasPermission(
          db,
          channel.belongsTo,
          request.actor.id,
          PERMISSIONS.ADD_REACTIONS,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions to add reactions' });
      }
    }

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

    // Federation: deliver Like to the appropriate inbox.
    if (request.actor.local && channel?.belongsTo) {
      const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
      if (group) {
        const cfg = fastify.config;
        const proto = cfg.secureCookies ? 'https' : 'http';
        const activityUri = `${proto}://${cfg.domain}/activities/${crypto.randomUUID()}`;
        if (!group.local && group.inboxUri) {
          // Remote server: alice signs, alice is the actor.
          const activity = serializeActivity(
            activityUri, 'Like', request.actor.uri,
            { id: message.uri, emoji },
            ['https://www.w3.org/ns/activitystreams#Public'],
            [group.followersUri ?? ''],
          );
          ensureActorKeys(db, request.actor)
            .then((k) => enqueueDelivery(db, activity, group.inboxUri!, k.id))
            .catch((err) => fastify.log.error(err, 'Reaction federation failed'));
        } else {
          // Local server: Group signs and is the outer actor.
          const activity = serializeActivity(
            activityUri, 'Like', group.uri,
            { id: message.uri, emoji, actor: request.actor.uri },
            ['https://www.w3.org/ns/activitystreams#Public'],
            [group.followersUri ?? ''],
          );
          ensureActorKeys(db, group)
            .then((k) => enqueueToFollowers(fastify, k, activity))
            .catch((err) => fastify.log.error(err, 'Reaction federation failed'));
        }
      }
    }

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

    // Federation: deliver Undo(Like) to the appropriate inbox.
    if (request.actor.local) {
      const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group) {
          const config = fastify.config;
          const protocol = config.secureCookies ? 'https' : 'http';
          const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            // Remote server: alice signs, alice is the actor.
            const activity = serializeActivity(
              activityUri, 'Undo', request.actor.uri,
              { type: 'Like', actor: request.actor.uri, object: { id: message.uri, emoji } },
              ['https://www.w3.org/ns/activitystreams#Public'],
              [group.followersUri ?? ''],
            );
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, activity, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Reaction undo federation failed'));
          } else {
            // Local server: Group signs and is the outer actor.
            const activity = serializeActivity(
              activityUri, 'Undo', group.uri,
              { type: 'Like', actor: request.actor.uri, object: { id: message.uri, emoji } },
              ['https://www.w3.org/ns/activitystreams#Public'],
              [group.followersUri ?? ''],
            );
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, activity))
              .catch((err) => fastify.log.error(err, 'Reaction undo federation failed'));
          }
        }
      }
    }

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

    // Federation: same remote-vs-local Group delivery as top-level messages.
    if (request.actor.local) {
      const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group && !group.local && group.inboxUri) {
          // Remote server: deliver to the origin Group's inbox.
          let contextUri: string | undefined;
          if (channel) contextUri = channel.uri;
          // Resolve the parent message URI so the receiver can
          // attach the reply to the correct thread.
          let inReplyToUri: string | undefined;
          if (reply_msg.inReplyTo) {
            const [parent] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, reply_msg.inReplyTo)).limit(1);
            if (parent) inReplyToUri = parent.uri;
          }
          const noteJson = serializeNote(reply_msg, request.actor.uri, contextUri, inReplyToUri);
          const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          const activity = serializeActivity(
            activityUri,
            'Create',
            request.actor.uri,
            noteJson,
            ['https://www.w3.org/ns/activitystreams#Public'],
            [group.followersUri ?? ''],
          );
          ensureActorKeys(db, request.actor)
            .then((actorWithKeys) =>
              enqueueDelivery(db, activity, group.inboxUri!, actorWithKeys.id),
            )
            .catch((err) => fastify.log.error(err, 'Remote group reply delivery failed'));
        } else if (group) {
          // Local server: fan out to remote followers.
          const actor = request.actor!;
          ensureActorKeys(db, actor)
            .then((actorWithKeys) => broadcastCreate(fastify, reply_msg, actorWithKeys))
            .catch((err) => fastify.log.error(err, 'Reply federation enqueue failed'));
          ensureActorKeys(db, group)
            .then((groupWithKeys) => broadcastToGroupFollowers(fastify, reply_msg, actor, groupWithKeys))
            .catch((err) => fastify.log.error(err, 'Reply group federation enqueue failed'));
        }
      }
    }

    return reply.status(201).send({ message: messageView, author: authorView });
  });

  // Look up a message by its copy-paste-friendly slug. Used by the
  // MessageEmbed component to render inline previews of [[msg:slug]]
  // refs. Returns a compact envelope with author, channel name, and
  // server name so the embed can display the reader's context
  // without additional fetches.
  //
  // Permission: caller must be able to access the message's channel.
  // For server-scoped channels that means server membership + any
  // private-channel access check. For DMs it means being a
  // participant in the DM. Returns 404 on both "not found" and "no
  // access" so embeds don't leak the existence of private messages.
  fastify.get<{ Params: { slug: string } }>(
    '/messages/by-slug/:slug',
    async (request, reply) => {
      // Auth: session cookie OR HTTP Signature. Signed requests come
      // from federation proxy calls (remote instance resolving a
      // [[msg:slug]] embed on behalf of a member). Unauthenticated
      // requests still fall through to public-channel-only access.
      const { slug } = request.params;
      if (!isValidMessageSlug(slug)) {
        return reply.status(400).send({ error: 'Invalid slug format' });
      }

      const [message] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.slug, slug), eq(objects.type, 'Note')))
        .limit(1);

      // If the slug isn't found locally and we have an authenticated
      // user, try proxying to remote servers the user is a member of.
      if (!message && request.actor) {
        const memberships = await db
          .select({ collectionUri: collectionItems.collectionUri })
          .from(collectionItems)
          .where(eq(collectionItems.itemUri, request.actor.uri));
        const followerUris = memberships.map((m) => m.collectionUri);
        const remoteGroups = await db
          .select()
          .from(actors)
          .where(and(eq(actors.type, 'Group'), eq(actors.local, false)));
        const memberGroups = remoteGroups.filter(
          (g) => g.followersUri && followerUris.includes(g.followersUri),
        );

        for (const group of memberGroups) {
          try {
            const origin = new URL(group.uri).origin;
            const result = await signedGet(
              db,
              request.actor.id,
              `${origin}/messages/by-slug/${encodeURIComponent(slug)}`,
            );
            if (result) return result;
          } catch {
            // Try next origin.
          }
        }
        return reply.status(404).send({ error: 'Message not found' });
      }

      if (!message) return reply.status(404).send({ error: 'Message not found' });

      const channelId = message.context;
      if (!channelId) return reply.status(404).send({ error: 'Message not found' });

      // For unauthenticated (federation proxy) requests, only serve
      // messages from public (non-private, non-DM) channels.
      const { channel } = await checkChannelAccess(
        db,
        channelId,
        request.actor?.uri ?? '',
      );
      if (!channel) return reply.status(404).send({ error: 'Message not found' });

      const channelProps = channel.properties as Record<string, unknown> | null;
      if (request.actor) {
        // Authenticated (session): full access check.
        const { allowed } = await checkChannelAccess(db, channelId, request.actor.uri);
        if (!allowed) return reply.status(404).send({ error: 'Message not found' });
      } else {
        // Unauthenticated or signed: only public channels.
        // (Signed requests from federation peers are treated the same
        // as unauthenticated for now — the signature proves identity
        // but we don't check membership. That's the next step if
        // private-channel embeds need to cross instances.)
        if (channelProps?.isPrivate || channelProps?.isDM) {
          return reply.status(404).send({ error: 'Message not found' });
        }
      }

      // Batch-load author + server metadata.
      const [author] = message.attributedTo
        ? await db.select().from(actors).where(eq(actors.id, message.attributedTo)).limit(1)
        : [null];
      const [server] = channel.belongsTo
        ? await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1)
        : [null];

      const chProps = channel.properties as Record<string, unknown> | null;
      const serverProps = server?.properties as Record<string, unknown> | null;

      return {
        id: message.id,
        slug: message.slug!,
        content: message.content ?? '',
        channelId: channel.id,
        channelName: (chProps?.name as string | undefined) ?? null,
        serverId: channel.belongsTo ?? null,
        serverName:
          (serverProps?.name as string | undefined) ??
          server?.displayName ??
          server?.preferredUsername ??
          null,
        author: author
          ? toAuthorView(author)
          : {
              id: message.attributedTo ?? '',
              preferredUsername: 'unknown',
              displayName: null,
              avatarUrl: null,
            },
        published: message.published.toISOString(),
        ...(message.updated &&
          message.updated.getTime() !== message.published.getTime() && {
            updated: message.updated.toISOString(),
          }),
      };
    },
  );
}
