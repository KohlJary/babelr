// SPDX-License-Identifier: Hippocratic-3.0
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { signRequest } from './signatures.ts';
import { serializeNote, serializeActivity } from './jsonld.ts';
import { objects } from '../db/schema/objects.ts';

const DELIVERY_TIMEOUT = 10_000;

export async function deliverActivity(
  actorPrivateKeyPem: string,
  actorUri: string,
  activity: Record<string, unknown>,
  recipientInboxUri: string,
): Promise<boolean> {
  const body = JSON.stringify(activity);
  const keyId = `${actorUri}#main-key`;

  const { headers } = signRequest(actorPrivateKeyPem, keyId, 'POST', recipientInboxUri, body);

  try {
    const res = await fetch(recipientInboxUri, {
      method: 'POST',
      body,
      headers: {
        ...headers,
        'Content-Type': 'application/activity+json',
        'User-Agent': 'Babelr/0.1.0',
      },
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT),
    });

    return res.ok || res.status === 202;
  } catch {
    return false;
  }
}

export async function deliverToFollowers(
  fastify: FastifyInstance,
  senderActor: typeof actors.$inferSelect,
  activity: Record<string, unknown>,
) {
  if (!senderActor.privateKeyPem || !senderActor.followersUri) return;

  const db = fastify.db;

  // Get all followers
  const followers = await db
    .select({ itemUri: collectionItems.itemUri, itemId: collectionItems.itemId })
    .from(collectionItems)
    .where(eq(collectionItems.collectionUri, senderActor.followersUri));

  // Collect unique remote inbox URIs
  const remoteInboxes = new Set<string>();

  for (const follower of followers) {
    if (!follower.itemId) continue;

    const [followerActor] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, follower.itemId))
      .limit(1);

    if (followerActor && !followerActor.local && followerActor.inboxUri) {
      remoteInboxes.add(followerActor.inboxUri);
    }
  }

  // Deliver to each remote inbox (fire-and-forget)
  for (const inboxUri of remoteInboxes) {
    deliverActivity(senderActor.privateKeyPem, senderActor.uri, activity, inboxUri).catch(
      (err) => {
        fastify.log.error({ err, inboxUri }, 'Federation delivery failed');
      },
    );
  }
}

export async function broadcastCreate(
  fastify: FastifyInstance,
  note: typeof objects.$inferSelect,
  senderActor: typeof actors.$inferSelect,
) {
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  const noteJson = serializeNote(note, senderActor.uri);
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

  const activity = serializeActivity(
    activityUri,
    'Create',
    senderActor.uri,
    noteJson,
    ['https://www.w3.org/ns/activitystreams#Public'],
    [senderActor.followersUri ?? ''],
  );

  await deliverToFollowers(fastify, senderActor, activity);
}
