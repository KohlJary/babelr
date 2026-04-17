// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, gt, inArray } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { readPositions } from '../db/schema/read-positions.ts';
import { reactions } from '../db/schema/reactions.ts';
import { notificationPreferences } from '../db/schema/notification-preferences.ts';
import type {
  MessageWithAuthor,
  MessageListResponse,
  CreateMessageInput,
  CreateChannelInput,
  UpdateChannelInput,
  WsServerMessage,
} from '@babelr/shared';
import { broadcastCreate, broadcastToGroupFollowers, enqueueToFollowers, enqueueDelivery, deliverDMCreate, deliverDMRead, signedGet } from '../federation/delivery.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { serializeActivity, serializeNote } from '../federation/jsonld.ts';
import { syncMessageOutboundLinks } from '../wiki-link-sync.ts';
import { PERMISSIONS, generateMessageSlug, isValidMessageSlug } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { writeAuditLog } from '../audit.ts';
import { broadcastPushToChannel } from '../push.ts';
import { unfurlLinks } from '../unfurl.ts';

const DEFAULT_LIMIT = 50;

// Parse @mentions from content and return array of mentioned usernames
export function parseMentions(content: string): string[] {
  const mentions: Set<string> = new Set();
  const mentionRegex = /@(\w+)/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.add(match[1]);
  }
  return Array.from(mentions);
}

// Serializers live in ../serializers.ts — re-exported here for
// backward compat while importers migrate.
import {
  toChannelView,
  toMessageView,
  toAuthorView,
  getMessagesForChannel,
  checkChannelAccess,
} from '../serializers.ts';
export {
  toChannelView,
  toMessageView,
  toAuthorView,
  getMessagesForChannel,
  checkChannelAccess,
};


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

  // Unfurl links asynchronously — don't block the response. When
  // previews resolve, patch the message properties and broadcast
  // a message:updated so clients render the preview cards.
  void (async () => {
    try {
      const previews = await unfurlLinks(content);
      if (previews.length > 0) {
        const existingProps = (note.properties as Record<string, unknown>) ?? {};
        await db
          .update(objects)
          .set({ properties: { ...existingProps, linkPreviews: previews } })
          .where(eq(objects.id, note.id));
        fastify.broadcastToChannel(channelId, {
          type: 'message:updated',
          payload: {
            messageId: note.id,
            channelId,
            content: note.content ?? '',
            updatedAt: new Date().toISOString(),
            linkPreviews: previews,
          },
        } as never);
      }
    } catch (err) {
      fastify.log.error(err, 'Link unfurl failed');
    }
  })();

  // Federation: enqueue delivery based on channel type
  if (actor.local) {
    const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
    const channelProps = (channel?.properties as Record<string, unknown> | null) ?? null;

    // Push notification to offline users (after channel lookup so we
    // can include channel/server name in the notification)
    const chName = (channelProps?.name as string) ?? undefined;
    let srvName: string | undefined;
    if (channel?.belongsTo) {
      const [srv] = await db.select().from(actors).where(eq(actors.id, channel.belongsTo)).limit(1);
      srvName = srv?.displayName ?? srv?.preferredUsername ?? undefined;
    }
    const sender = actor.displayName ?? actor.preferredUsername;
    const pushTitle = srvName && chName
      ? `${sender} · #${chName} · ${srvName}`
      : chName
        ? `${sender} · #${chName}`
        : sender;
    void broadcastPushToChannel(fastify, channelId, actor.id, {
      title: pushTitle,
      body: content.trim().slice(0, 200),
      tag: `msg-${channelId}`,
      data: { channelId, messageId: note.id },
    }).catch((err) => fastify.log.error(err, 'Push broadcast failed'));
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

      // Notify all connected clients about the new channel.
      fastify.broadcastToAllSubscribers({
        type: 'server:updated',
        payload: { serverId: request.params.serverId },
      });

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'channel',
        action: 'channel.create',
        summary: `Created channel #${name}`,
        details: { channelId: channel.id, name, isPrivate },
      });

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

      if (channel.belongsTo) {
        fastify.broadcastToAllSubscribers({
          type: 'server:updated',
          payload: { serverId: channel.belongsTo },
        });
      }

      await writeAuditLog(db, {
        serverId: channel.belongsTo,
        actorId: request.actor.id,
        category: 'channel',
        action: 'channel.update',
        summary: `Updated channel #${name ?? (currentProps.name as string)}`,
        details: { channelId },
      });

      return toChannelView(updated);
    },
  );
}
