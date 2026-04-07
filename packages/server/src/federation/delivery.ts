// SPDX-License-Identifier: Hippocratic-3.0
import { eq, and, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { deliveryQueue } from '../db/schema/delivery-queue.ts';
import { signRequest } from './signatures.ts';
import { serializeNote, serializeActivity } from './jsonld.ts';
import { objects } from '../db/schema/objects.ts';
import type { Database } from '../db/index.ts';

const DELIVERY_TIMEOUT = 10_000;
const QUEUE_INTERVAL = 5_000;
const BATCH_SIZE = 10;

// --- Queue-based delivery ---

export async function enqueueDelivery(
  db: Database,
  activity: Record<string, unknown>,
  recipientInboxUri: string,
  senderActorId: string,
) {
  await db.insert(deliveryQueue).values({
    activityJson: activity,
    recipientInboxUri,
    senderActorId,
  });
}

async function attemptDelivery(
  privateKeyPem: string,
  actorUri: string,
  activity: Record<string, unknown>,
  recipientInboxUri: string,
): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify(activity);
  const keyId = `${actorUri}#main-key`;
  const { headers } = signRequest(privateKeyPem, keyId, 'POST', recipientInboxUri, body);

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

    if (res.ok || res.status === 202) {
      return { ok: true };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function processQueue(fastify: FastifyInstance) {
  const db = fastify.db;

  // Fetch pending items ready for attempt
  const items = await db
    .select()
    .from(deliveryQueue)
    .where(
      and(eq(deliveryQueue.status, 'pending'), lte(deliveryQueue.nextAttemptAt, new Date())),
    )
    .limit(BATCH_SIZE);

  for (const item of items) {
    // Fetch sender actor for signing
    const [sender] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, item.senderActorId))
      .limit(1);

    if (!sender?.privateKeyPem) {
      await db
        .update(deliveryQueue)
        .set({ status: 'failed', lastError: 'Sender has no signing key' })
        .where(eq(deliveryQueue.id, item.id));
      continue;
    }

    const result = await attemptDelivery(
      sender.privateKeyPem,
      sender.uri,
      item.activityJson as Record<string, unknown>,
      item.recipientInboxUri,
    );

    if (result.ok) {
      await db
        .update(deliveryQueue)
        .set({ status: 'delivered' })
        .where(eq(deliveryQueue.id, item.id));
    } else {
      const attempts = item.attempts + 1;
      if (attempts >= item.maxAttempts) {
        await db
          .update(deliveryQueue)
          .set({ status: 'failed', attempts, lastError: result.error ?? null })
          .where(eq(deliveryQueue.id, item.id));
      } else {
        // Exponential backoff: 30s, 60s, 120s, 240s
        const backoffMs = Math.pow(2, attempts) * 30_000;
        await db
          .update(deliveryQueue)
          .set({
            attempts,
            nextAttemptAt: new Date(Date.now() + backoffMs),
            lastError: result.error ?? null,
          })
          .where(eq(deliveryQueue.id, item.id));
      }
    }
  }
}

export function startQueueProcessor(fastify: FastifyInstance) {
  const interval = setInterval(() => {
    processQueue(fastify).catch((err) => {
      fastify.log.error(err, 'Queue processing error');
    });
  }, QUEUE_INTERVAL);

  fastify.addHook('onClose', () => {
    clearInterval(interval);
  });

  fastify.log.info('Delivery queue processor started');
}

// --- High-level delivery helpers ---

export async function enqueueToFollowers(
  fastify: FastifyInstance,
  senderActor: typeof actors.$inferSelect,
  activity: Record<string, unknown>,
) {
  const db = fastify.db;
  if (!senderActor.followersUri) return;

  const followers = await db
    .select({ itemId: collectionItems.itemId })
    .from(collectionItems)
    .where(eq(collectionItems.collectionUri, senderActor.followersUri));

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

  for (const inboxUri of remoteInboxes) {
    await enqueueDelivery(db, activity, inboxUri, senderActor.id);
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

  await enqueueToFollowers(fastify, senderActor, activity);
}

// Also enqueue to Group followers when posting in a server channel
export async function broadcastToGroupFollowers(
  fastify: FastifyInstance,
  note: typeof objects.$inferSelect,
  senderActor: typeof actors.$inferSelect,
  groupActor: typeof actors.$inferSelect,
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
    [groupActor.followersUri ?? ''],
  );

  await enqueueToFollowers(fastify, groupActor, activity);
}
