// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { actors } from '../db/schema/actors.ts';
import { serializeActivity } from './jsonld.ts';
import { enqueueDelivery } from './delivery.ts';

/**
 * Send a Follow activity from `sender` to `target`'s inbox to initiate a
 * friend request. The activity id encodes the local friendship row id so that
 * a matching Accept can map back to it.
 */
export async function sendFollowRequest(
  fastify: FastifyInstance,
  sender: typeof actors.$inferSelect,
  target: typeof actors.$inferSelect,
  friendshipId: string,
) {
  if (target.local || !target.inboxUri) return;

  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const activityUri = `${protocol}://${config.domain}/activities/friendships/${friendshipId}`;

  const activity = serializeActivity(
    activityUri,
    'Follow',
    sender.uri,
    target.uri,
    [target.uri],
    [],
  );

  await enqueueDelivery(fastify.db, activity, target.inboxUri, sender.id);
}

/**
 * Send an Accept wrapping the original Follow activity id so the other
 * side can mark their pending_out row as accepted.
 */
export async function sendFriendAccept(
  fastify: FastifyInstance,
  sender: typeof actors.$inferSelect,
  target: typeof actors.$inferSelect,
  friendshipId: string,
) {
  if (target.local || !target.inboxUri) return;

  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

  // Reconstruct the Follow URI the remote side originally sent — they used
  // their own friendship id, which we stored in the activity id fragment.
  // We need to find THEIR friendship id. We don't have it directly, so we
  // use the object field to identify the Follow by sender+target pair.
  const followObject = {
    type: 'Follow',
    actor: target.uri,
    object: sender.uri,
  };

  const activity = serializeActivity(
    activityUri,
    'Accept',
    sender.uri,
    followObject,
    [target.uri],
    [],
  );

  // Also attach the friendship id as a property so target can correlate
  (activity as Record<string, unknown>).babelrFriendshipRef = friendshipId;

  await enqueueDelivery(fastify.db, activity, target.inboxUri, sender.id);
}

/**
 * Send an Undo(Follow) activity to tear down the friendship on the other side.
 */
export async function sendFriendUndo(
  fastify: FastifyInstance,
  sender: typeof actors.$inferSelect,
  target: typeof actors.$inferSelect,
  friendshipId: string,
) {
  if (target.local || !target.inboxUri) return;

  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
  const followUri = `${protocol}://${config.domain}/activities/friendships/${friendshipId}`;

  const undoObject = {
    id: followUri,
    type: 'Follow',
    actor: sender.uri,
    object: target.uri,
  };

  const activity = serializeActivity(
    activityUri,
    'Undo',
    sender.uri,
    undoObject,
    [target.uri],
    [],
  );

  await enqueueDelivery(fastify.db, activity, target.inboxUri, sender.id);
}
