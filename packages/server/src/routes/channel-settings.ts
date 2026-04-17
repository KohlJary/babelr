// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, gt } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { readPositions } from '../db/schema/read-positions.ts';
import { notificationPreferences } from '../db/schema/notification-preferences.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { enqueueDelivery, deliverDMRead } from '../federation/delivery.ts';
import { serializeActivity } from '../federation/jsonld.ts';

export default async function channelSettingsRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

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
}
