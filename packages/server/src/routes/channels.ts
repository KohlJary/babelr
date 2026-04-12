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
  UpdateChannelInput,
  WsServerMessage,
} from '@babelr/shared';
import { broadcastCreate, broadcastToGroupFollowers, enqueueToFollowers, enqueueDelivery, deliverDMCreate, deliverDMRead } from '../federation/delivery.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { serializeActivity, serializeNote } from '../federation/jsonld.ts';
import { syncMessageOutboundLinks } from '../wiki-link-sync.ts';
import { PERMISSIONS, generateMessageSlug, isValidMessageSlug } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';

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
  const channelType = (props?.channelType as 'text' | 'voice' | undefined) ?? 'text';
  return {
    id: obj.id,
    name: (props?.name as string) ?? 'unnamed',
    serverId: obj.belongsTo,
    channelType,
    ...(props?.category ? { category: props.category as string } : {}),
    ...(props?.isPrivate ? { isPrivate: true } : {}),
    ...(props?.topic ? { topic: props.topic as string } : {}),
    ...(props?.description ? { description: props.description as string } : {}),
    ...(typeof props?.slowMode === 'number' && props.slowMode > 0
      ? { slowMode: props.slowMode as number }
      : {}),
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
    slug: obj.slug ?? null,
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
    uri: actor.uri,
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

  // Generate a short message slug. Collision probability at 31^10
  // is vanishingly small, but we still retry a bounded number of
  // times if the partial unique index rejects the insert — keeps
  // the invariant even under a theoretical worst case.
  let note: typeof objects.$inferSelect | undefined;
  let slugAttempts = 0;
  while (!note) {
    slugAttempts += 1;
    try {
      const [inserted] = await db
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
          slug: generateMessageSlug(),
        })
        .returning();
      note = inserted;
    } catch (err) {
      // Retry on unique-index violation — but only the slug index,
      // not e.g. the uri index which would indicate a real bug.
      const pgErr = err as { code?: string; constraint_name?: string };
      if (pgErr.code === '23505' && slugAttempts <= 5) {
        continue;
      }
      throw err;
    }
  }

  await db.insert(activities).values({
    uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
    type: 'Create',
    actorId: actor.id,
    objectUri: note.uri,
    objectId: note.id,
    to: [],
    cc: [],
  });

  // Sync [[slug]] wiki refs — no-op for DMs, only runs for server channels
  await syncMessageOutboundLinks(db, note.id, channelId, note.content ?? '');

  const messageView = toMessageView(note);
  const authorView = toAuthorView(actor);

  fastify.broadcastToChannel(channelId, {
    type: 'message:new',
    payload: { message: messageView, author: authorView },
  });

  // Federation: enqueue delivery based on channel type
  if (actor.local) {
    const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
    const channelProps = (channel?.properties as Record<string, unknown> | null) ?? null;
    const isDM = channel && !channel.belongsTo && channelProps?.isDM === true;

    if (isDM) {
      // DM: target only remote participant(s) directly
      const participants = await db
        .select({ actor: actors })
        .from(collectionItems)
        .innerJoin(actors, eq(collectionItems.itemId, actors.id))
        .where(eq(collectionItems.collectionUri, channel.uri));

      const remoteRecipients = participants
        .map((p) => p.actor)
        .filter((a) => !a.local && a.inboxUri);

      if (remoteRecipients.length > 0) {
        ensureActorKeys(db, actor)
          .then(async (actorWithKeys) => {
            for (const recipient of remoteRecipients) {
              await deliverDMCreate(fastify, note, actorWithKeys, recipient);
            }
          })
          .catch((err) => fastify.log.error(err, 'DM federation enqueue failed'));
      }
    } else if (!messageProperties?.encrypted) {
      if (channel?.belongsTo) {
        const [group] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
        if (group && !group.local) {
          // Remote server: deliver the Create to the origin Group's
          // inbox so the origin can relay it to all members. Fanning
          // out locally would be useless — B's followers collection
          // for the remote Group only contains bob (the sender).
          if (group.inboxUri) {
            let contextUri: string | undefined;
            const [ch] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, channelId)).limit(1);
            if (ch) contextUri = ch.uri;
            const noteJson = serializeNote(note, actor.uri, contextUri);
            const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
            const activity = serializeActivity(
              activityUri,
              'Create',
              actor.uri,
              noteJson,
              ['https://www.w3.org/ns/activitystreams#Public'],
              [group.followersUri ?? ''],
            );
            ensureActorKeys(db, actor)
              .then((actorWithKeys) =>
                enqueueDelivery(db, activity, group.inboxUri!, actorWithKeys.id),
              )
              .catch((err) => fastify.log.error(err, 'Remote group delivery enqueue failed'));
          }
        } else if (group) {
          // Local server: fan out to the Group's remote followers
          // (the existing path).
          ensureActorKeys(db, actor)
            .then((actorWithKeys) => broadcastCreate(fastify, note, actorWithKeys))
            .catch((err) => fastify.log.error(err, 'Federation enqueue failed'));
          ensureActorKeys(db, group)
            .then((groupWithKeys) => broadcastToGroupFollowers(fastify, note, actor, groupWithKeys))
            .catch((err) => fastify.log.error(err, 'Group federation enqueue failed'));
        }
      } else {
        // No server owner (legacy channel) — personal fanout only.
        ensureActorKeys(db, actor)
          .then((actorWithKeys) => broadcastCreate(fastify, note, actorWithKeys))
          .catch((err) => fastify.log.error(err, 'Federation enqueue failed'));
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

export default async function channelRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // List channels in a server
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/channels',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      if (
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_CHANNELS,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      // For remote servers, re-fetch the channel list from the origin
      // on every listing request so newly-created channels show up
      // without the user needing to leave and re-join. The fetch is
      // fast (single HTTP call) and the upsert is idempotent.
      const [serverActor] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.params.serverId))
        .limit(1);
      if (serverActor && !serverActor.local) {
        try {
          const origin = new URL(serverActor.uri).origin;
          const slug = serverActor.preferredUsername;
          const channelsUrl = `${origin}/groups/${encodeURIComponent(slug)}/channels`;
          const res = await fetch(channelsUrl, {
            headers: { Accept: 'application/json', 'User-Agent': 'Babelr/0.1.0' },
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              channels: Array<{
                uri: string;
                name: string;
                channelType?: string;
                topic?: string;
                category?: string;
              }>;
            };
            for (const ch of data.channels ?? []) {
              await db
                .insert(objects)
                .values({
                  uri: ch.uri,
                  type: 'OrderedCollection',
                  belongsTo: serverActor.id,
                  properties: {
                    name: ch.name,
                    channelType: ch.channelType ?? 'text',
                    ...(ch.topic ? { topic: ch.topic } : {}),
                    ...(ch.category ? { category: ch.category } : {}),
                  },
                })
                .onConflictDoNothing({ target: objects.uri });
            }
          }
        } catch {
          // Non-fatal — serve whatever we have cached.
        }
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

      const { name, category, isPrivate, channelType } = request.body;
      if (!name || name.trim().length === 0) {
        return reply.status(400).send({ error: 'Channel name is required' });
      }
      const kind = channelType === 'voice' ? 'voice' : 'text';

      // Verify server exists
      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      // AUDIT BUG FIX: channel creation previously had no permission
      // check at all — any member could create a channel. Now gated
      // on MANAGE_CHANNELS.
      if (
        !(await hasPermission(db, server.id, request.actor.id, PERMISSIONS.MANAGE_CHANNELS))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
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
            channelType: kind,
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

  // Update channel settings (owner/admin/moderator)
  fastify.put<{ Params: { channelId: string }; Body: UpdateChannelInput }>(
    '/channels/:channelId',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { channelId } = request.params;
      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);

      if (!channel) return reply.status(404).send({ error: 'Channel not found' });
      if (!channel.belongsTo) return reply.status(400).send({ error: 'Not a server channel' });

      if (
        !(await hasPermission(
          db,
          channel.belongsTo,
          request.actor.id,
          PERMISSIONS.MANAGE_CHANNELS,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const { name, category, topic, description, slowMode } = request.body ?? {};
      const currentProps = (channel.properties as Record<string, unknown> | null) ?? {};
      const nextProps = { ...currentProps };

      if (name !== undefined) {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          return reply.status(400).send({ error: 'Channel name cannot be empty' });
        }
        nextProps.name = trimmed;
      }
      if (category !== undefined) {
        const t = category?.trim();
        if (t) nextProps.category = t;
        else delete nextProps.category;
      }
      if (topic !== undefined) {
        const t = topic?.trim();
        if (t) nextProps.topic = t;
        else delete nextProps.topic;
      }
      if (description !== undefined) {
        const t = description?.trim();
        if (t) nextProps.description = t;
        else delete nextProps.description;
      }
      if (slowMode !== undefined) {
        const n = Math.max(0, Math.min(21600, Math.floor(slowMode))); // cap at 6 hours
        if (n > 0) nextProps.slowMode = n;
        else delete nextProps.slowMode;
      }

      const [updated] = await db
        .update(objects)
        .set({ properties: nextProps, updated: new Date() })
        .where(eq(objects.id, channel.id))
        .returning();

      return toChannelView(updated);
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

      // Federate read receipts for DMs with remote participants
      const channelProps = channel.properties as Record<string, unknown> | null;
      if (!channel.belongsTo && channelProps?.isDM && request.actor.local) {
        const sender = request.actor;
        (async () => {
          try {
            // Find the most recent remote-authored message in this DM to use as the Read target
            const [latestRemote] = await db
              .select({ object: objects, actor: actors })
              .from(objects)
              .innerJoin(actors, eq(objects.attributedTo, actors.id))
              .where(and(eq(objects.context, channelId), eq(objects.type, 'Note'), eq(actors.local, false)))
              .orderBy(desc(objects.published))
              .limit(1);

            if (!latestRemote) return;

            const senderWithKeys = await ensureActorKeys(db, sender);
            await deliverDMRead(
              fastify,
              senderWithKeys,
              latestRemote.actor,
              latestRemote.object.uri,
              now.toISOString(),
            );
          } catch (err) {
            fastify.log.error(err, 'DM read receipt federation failed');
          }
        })();
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

      // Federation: if the invited user is remote, deliver an Add
      // activity to their inbox so their instance creates a shadow
      // channel and adds them to it. The activity carries enough
      // channel metadata for the receiving instance to construct
      // the shadow without a follow-up fetch.
      if (!user.local && user.inboxUri && request.actor.local) {
        const config = fastify.config;
        const protocol = config.secureCookies ? 'https' : 'http';
        const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
        const activity = serializeActivity(
          activityUri,
          'Add',
          request.actor.uri,
          {
            type: 'OrderedCollection',
            id: channel.uri,
            name: (props as Record<string, unknown>)?.name ?? 'unnamed',
            channelType: (props as Record<string, unknown>)?.channelType ?? 'text',
            ...(props?.topic ? { topic: props.topic } : {}),
            ...(props?.category ? { category: props.category } : {}),
            isPrivate: true,
            belongsTo: channel.belongsTo,
          },
          [user.uri],
          [],
        );
        ensureActorKeys(db, request.actor)
          .then((actorWithKeys) =>
            enqueueDelivery(db, activity, user.inboxUri!, actorWithKeys.id),
          )
          .catch((err) => fastify.log.error(err, 'Channel invite federation failed'));
      }

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
      // Auth is optional for this endpoint: authenticated users get
      // full access checks, unauthenticated requests (including
      // federation proxy calls from remote instances) only receive
      // messages from public channels. This mirrors AP semantics —
      // public notes are public.
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
            const res = await fetch(
              `${origin}/messages/by-slug/${encodeURIComponent(slug)}`,
              {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'Babelr/0.1.0',
                },
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (res.ok) {
              return await res.json();
            }
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
      if (!request.actor) {
        // Unauthenticated: only public channels.
        if (channelProps?.isPrivate || channelProps?.isDM) {
          return reply.status(404).send({ error: 'Message not found' });
        }
      } else {
        // Authenticated: full access check.
        const { allowed } = await checkChannelAccess(db, channelId, request.actor.uri);
        if (!allowed) return reply.status(404).send({ error: 'Message not found' });
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
