// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { friendships } from '../db/schema/friendships.ts';
import type { FriendshipView, FriendshipState } from '@babelr/shared';
import { toAuthorView } from './channels.ts';
import { lookupActorByHandle } from '../federation/resolve.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import {
  sendFollowRequest,
  sendFriendAccept,
  sendFriendUndo,
} from '../federation/friends-delivery.ts';

function toFriendshipView(
  row: typeof friendships.$inferSelect,
  otherActor: typeof actors.$inferSelect,
): FriendshipView {
  return {
    id: row.id,
    state: row.state as FriendshipState,
    other: toAuthorView(otherActor),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function friendsRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // List friendships
  fastify.get('/friends', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const rows = await db
      .select({ friendship: friendships, other: actors })
      .from(friendships)
      .innerJoin(actors, eq(friendships.otherActorId, actors.id))
      .where(eq(friendships.ownerActorId, request.actor.id));

    return rows.map((r) => toFriendshipView(r.friendship, r.other));
  });

  // Send a friend request by handle
  fastify.post<{ Body: { handle: string } }>('/friends', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const raw = (request.body?.handle ?? '').trim().replace(/^@/, '');
    if (!raw) return reply.status(400).send({ error: 'handle is required' });

    const domain = fastify.config.domain;
    const atIndex = raw.indexOf('@');
    let other: typeof actors.$inferSelect | null = null;

    if (atIndex === -1 || raw.slice(atIndex + 1) === domain) {
      const username = atIndex === -1 ? raw : raw.slice(0, atIndex);
      const [local] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.preferredUsername, username), eq(actors.local, true), eq(actors.type, 'Person')))
        .limit(1);
      other = local ?? null;
    } else {
      other = await lookupActorByHandle(db, raw);
    }

    if (!other) return reply.status(404).send({ error: 'User not found' });
    if (other.id === request.actor.id)
      return reply.status(400).send({ error: 'Cannot friend yourself' });

    // Check existing friendship row
    const [existing] = await db
      .select()
      .from(friendships)
      .where(
        and(eq(friendships.ownerActorId, request.actor.id), eq(friendships.otherActorId, other.id)),
      )
      .limit(1);

    if (existing) {
      // If already pending_in (they requested us), treat POST as acceptance
      if (existing.state === 'pending_in') {
        return reply.status(409).send({
          error: 'Friend request already received — use accept endpoint',
          friendshipId: existing.id,
        });
      }
      return toFriendshipView(existing, other);
    }

    // Create pending_out row
    const [row] = await db
      .insert(friendships)
      .values({
        ownerActorId: request.actor.id,
        otherActorId: other.id,
        state: 'pending_out',
      })
      .returning();

    // If the other side is also local, immediately create their pending_in mirror
    if (other.local) {
      await db
        .insert(friendships)
        .values({
          ownerActorId: other.id,
          otherActorId: request.actor.id,
          state: 'pending_in',
        })
        .onConflictDoNothing();

      // Push WS notification to the local recipient
      const [mirror] = await db
        .select()
        .from(friendships)
        .where(
          and(eq(friendships.ownerActorId, other.id), eq(friendships.otherActorId, request.actor.id)),
        )
        .limit(1);
      if (mirror) {
        fastify.broadcastToActor(other.id, {
          type: 'friend:request',
          payload: { friendship: toFriendshipView(mirror, request.actor) },
        });
      }
    } else {
      // Federate: send Follow activity to remote inbox
      ensureActorKeys(db, request.actor)
        .then((actorWithKeys) => sendFollowRequest(fastify, actorWithKeys, other!, row.id))
        .catch((err) => fastify.log.error(err, 'Friend Follow enqueue failed'));
    }

    return reply.status(201).send(toFriendshipView(row, other));
  });

  // Accept a friend request
  fastify.post<{ Params: { friendshipId: string } }>(
    '/friends/:friendshipId/accept',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [row] = await db
        .select()
        .from(friendships)
        .where(
          and(
            eq(friendships.id, request.params.friendshipId),
            eq(friendships.ownerActorId, request.actor.id),
          ),
        )
        .limit(1);

      if (!row) return reply.status(404).send({ error: 'Friendship not found' });
      if (row.state !== 'pending_in')
        return reply.status(400).send({ error: `Cannot accept in state ${row.state}` });

      const now = new Date();
      const [updated] = await db
        .update(friendships)
        .set({ state: 'accepted', updatedAt: now })
        .where(eq(friendships.id, row.id))
        .returning();

      // Upgrade the mirror row on the other side (if local) or send Accept activity (if remote)
      const [other] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, row.otherActorId))
        .limit(1);
      if (!other) return reply.status(500).send({ error: 'Other actor missing' });

      if (other.local) {
        await db
          .update(friendships)
          .set({ state: 'accepted', updatedAt: now })
          .where(
            and(
              eq(friendships.ownerActorId, other.id),
              eq(friendships.otherActorId, request.actor.id),
            ),
          );

        const [mirror] = await db
          .select()
          .from(friendships)
          .where(
            and(
              eq(friendships.ownerActorId, other.id),
              eq(friendships.otherActorId, request.actor.id),
            ),
          )
          .limit(1);
        if (mirror) {
          fastify.broadcastToActor(other.id, {
            type: 'friend:accepted',
            payload: { friendship: toFriendshipView(mirror, request.actor) },
          });
        }
      } else {
        ensureActorKeys(db, request.actor)
          .then((actorWithKeys) => sendFriendAccept(fastify, actorWithKeys, other, row.id))
          .catch((err) => fastify.log.error(err, 'Friend Accept enqueue failed'));
      }

      return toFriendshipView(updated, other);
    },
  );

  // Remove a friendship (cancel request, decline, or unfriend)
  fastify.delete<{ Params: { friendshipId: string } }>(
    '/friends/:friendshipId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [row] = await db
        .select()
        .from(friendships)
        .where(
          and(
            eq(friendships.id, request.params.friendshipId),
            eq(friendships.ownerActorId, request.actor.id),
          ),
        )
        .limit(1);

      if (!row) return reply.status(404).send({ error: 'Friendship not found' });

      const [other] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, row.otherActorId))
        .limit(1);

      await db.delete(friendships).where(eq(friendships.id, row.id));

      // Remove mirror on the other side if local; otherwise federate Undo
      if (other?.local) {
        const [mirror] = await db
          .select()
          .from(friendships)
          .where(
            and(
              eq(friendships.ownerActorId, other.id),
              eq(friendships.otherActorId, request.actor.id),
            ),
          )
          .limit(1);
        if (mirror) {
          await db
            .delete(friendships)
            .where(eq(friendships.id, mirror.id));
          fastify.broadcastToActor(other.id, {
            type: 'friend:removed',
            payload: { friendshipId: mirror.id },
          });
        }
      } else if (other) {
        ensureActorKeys(db, request.actor)
          .then((actorWithKeys) => sendFriendUndo(fastify, actorWithKeys, other, row.id))
          .catch((err) => fastify.log.error(err, 'Friend Undo enqueue failed'));
      }

      return { ok: true };
    },
  );
}

