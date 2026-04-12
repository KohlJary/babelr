// SPDX-License-Identifier: Hippocratic-3.0
import { eq, and, lte, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { deliveryQueue } from '../db/schema/delivery-queue.ts';
import { friendships } from '../db/schema/friendships.ts';
import { signRequest } from './signatures.ts';
import { serializeNote, serializeActivity, serializeActor } from './jsonld.ts';
import { objects } from '../db/schema/objects.ts';
import { ensureActorKeys } from './keys.ts';
import type { Database } from '../db/index.ts';

const DELIVERY_TIMEOUT = 10_000;

/**
 * Perform an HTTP-signed GET request on behalf of a local actor.
 * Used for federation proxy calls (by-slug lookups, channel/member
 * listing) so the receiving instance can verify the caller is a
 * known actor rather than an anonymous crawler. Returns the parsed
 * JSON response, or null on failure.
 */
export async function signedGet<T = unknown>(
  db: Database,
  actorId: string,
  url: string,
): Promise<T | null> {
  const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1);
  if (!actor?.local) return null;

  const actorWithKeys = await ensureActorKeys(db, actor);
  if (!actorWithKeys.privateKeyPem) return null;

  const keyId = `${actor.uri}#main-key`;
  const { headers } = signRequest(actorWithKeys.privateKeyPem, keyId, 'GET', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        Accept: 'application/json',
        'User-Agent': 'Babelr/0.1.0',
      },
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
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
  const db = fastify.db;

  // Resolve the channel URI so remote instances can route the
  // message into the correct shadow channel on their end.
  let contextUri: string | undefined;
  if (note.context) {
    const [ch] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, note.context)).limit(1);
    if (ch) contextUri = ch.uri;
  }

  // Resolve the parent message URI for threaded replies.
  let inReplyToUri: string | undefined;
  if (note.inReplyTo) {
    const [parent] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, note.inReplyTo)).limit(1);
    if (parent) inReplyToUri = parent.uri;
  }

  const noteJson = serializeNote(note, senderActor.uri, contextUri, inReplyToUri);
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

// Send a Read activity to a remote actor marking an object as read at a given timestamp
export async function deliverDMRead(
  fastify: FastifyInstance,
  senderActor: typeof actors.$inferSelect,
  recipientActor: typeof actors.$inferSelect,
  objectUri: string,
  publishedIso: string,
) {
  if (recipientActor.local || !recipientActor.inboxUri) return;

  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

  const activity = {
    ...serializeActivity(activityUri, 'Read', senderActor.uri, objectUri, [recipientActor.uri], []),
    published: publishedIso,
  };

  await enqueueDelivery(fastify.db, activity, recipientActor.inboxUri, senderActor.id);
}

// Targeted delivery for DMs — send a Create activity to a single remote recipient
export async function deliverDMCreate(
  fastify: FastifyInstance,
  note: typeof objects.$inferSelect,
  senderActor: typeof actors.$inferSelect,
  recipientActor: typeof actors.$inferSelect,
) {
  if (recipientActor.local || !recipientActor.inboxUri) return;

  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  const noteJson = {
    ...serializeNote(note, senderActor.uri),
    to: [recipientActor.uri],
    cc: [],
  };
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

  const activity = serializeActivity(
    activityUri,
    'Create',
    senderActor.uri,
    noteJson,
    [recipientActor.uri],
    [],
  );

  await enqueueDelivery(fastify.db, activity, recipientActor.inboxUri, senderActor.id);
}

/**
 * Deliver an Update(Actor) activity to every remote actor with an
 * accepted friendship row pointing at `updatedActor`. Used when a
 * user changes their display name, avatar, or bio — the friends-of-
 * friend set is the smallest audience that covers the visible-
 * papercut case where a friend on another instance would otherwise
 * keep showing the old profile until the resolver cache expires.
 *
 * The activity body inlines the full serialized actor (not just the
 * diff) so receiving instances can overwrite their cached row in one
 * shot without needing a follow-up fetch.
 */
export async function broadcastActorUpdate(
  fastify: FastifyInstance,
  updatedActor: typeof actors.$inferSelect,
) {
  if (!updatedActor.local) return;

  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  // Find every remote actor that's in an accepted friendship with
  // the updater. We look at both directions (owner → other and
  // other → owner) because friendship rows are stored per-owner.
  const outgoing = await db
    .select({ otherId: friendships.otherActorId })
    .from(friendships)
    .where(
      and(
        eq(friendships.ownerActorId, updatedActor.id),
        eq(friendships.state, 'accepted'),
      ),
    );
  const incoming = await db
    .select({ ownerId: friendships.ownerActorId })
    .from(friendships)
    .where(
      and(
        eq(friendships.otherActorId, updatedActor.id),
        eq(friendships.state, 'accepted'),
      ),
    );

  const friendIds = new Set<string>();
  for (const row of outgoing) friendIds.add(row.otherId);
  for (const row of incoming) friendIds.add(row.ownerId);
  if (friendIds.size === 0) return;

  const friendRows = await db
    .select()
    .from(actors)
    .where(inArray(actors.id, Array.from(friendIds)));

  const remoteInboxes = new Set<string>();
  for (const f of friendRows) {
    if (!f.local && f.inboxUri) remoteInboxes.add(f.inboxUri);
  }
  if (remoteInboxes.size === 0) return;

  // Serialize the actor freshly so the remote sees the new state,
  // including any key material that may have been injected by
  // ensureActorKeys.
  const actorWithKeys = await ensureActorKeys(db, updatedActor);
  const actorJson = serializeActor(actorWithKeys);
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
  const activity = serializeActivity(
    activityUri,
    'Update',
    updatedActor.uri,
    actorJson,
    [updatedActor.followersUri ?? 'https://www.w3.org/ns/activitystreams#Public'],
    [],
  );

  for (const inboxUri of remoteInboxes) {
    await enqueueDelivery(db, activity, inboxUri, updatedActor.id);
  }
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
  const db = fastify.db;

  let contextUri: string | undefined;
  if (note.context) {
    const [ch] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, note.context)).limit(1);
    if (ch) contextUri = ch.uri;
  }

  let inReplyToUri: string | undefined;
  if (note.inReplyTo) {
    const [parent] = await db.select({ uri: objects.uri }).from(objects).where(eq(objects.id, note.inReplyTo)).limit(1);
    if (parent) inReplyToUri = parent.uri;
  }

  const noteJson = serializeNote(note, senderActor.uri, contextUri, inReplyToUri);
  const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;

  // The Group is the outer `actor` — it's the entity that signed and
  // relayed this Note to its followers. The Note's `attributedTo`
  // still points at the original author (senderActor.uri) so
  // receivers know who actually wrote the message. This separation
  // is critical for inbox verification: the receiver checks that
  // `activity.actor === signing key owner`, which only holds when
  // the Group is the claimed actor.
  const activity = serializeActivity(
    activityUri,
    'Create',
    groupActor.uri,
    noteJson,
    ['https://www.w3.org/ns/activitystreams#Public'],
    [groupActor.followersUri ?? ''],
  );

  await enqueueToFollowers(fastify, groupActor, activity);
}
