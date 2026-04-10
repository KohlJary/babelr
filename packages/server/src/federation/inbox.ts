// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { friendships } from '../db/schema/friendships.ts';
import { toAuthorView } from '../routes/channels.ts';
import { verifySignatureFromParts, getKeyIdFromSignature } from './signatures.ts';
import { resolveActorByKeyId, resolveObject } from './resolve.ts';
import { enqueueDelivery } from './delivery.ts';
import { serializeActivity } from './jsonld.ts';
import { ensureActorKeys } from './keys.ts';

interface APActivity {
  id?: string;
  type: string;
  actor: string;
  object: string | { id?: string; type?: string; actor?: string; content?: string; [key: string]: unknown };
  to?: string[];
  cc?: string[];
}

async function verifyInboxRequest(
  fastify: FastifyInstance,
  request: { headers: Record<string, string | string[] | undefined>; method: string; url: string; body: APActivity },
) {
  const signatureHeader = request.headers.signature as string | undefined;
  if (!signatureHeader) return null;

  const keyId = getKeyIdFromSignature(signatureHeader);
  const remoteActor = await resolveActorByKeyId(fastify.db, keyId);
  if (!remoteActor) return null;

  const apPublicKey = (remoteActor.properties as Record<string, unknown>)?.apPublicKey as
    | { publicKeyPem?: string }
    | undefined;
  if (!apPublicKey?.publicKeyPem) return null;

  const valid = verifySignatureFromParts(
    apPublicKey.publicKeyPem,
    signatureHeader,
    request.method,
    request.url,
    {
      host: (request.headers.host as string) ?? '',
      date: (request.headers.date as string) ?? '',
      digest: (request.headers.digest as string) ?? '',
    },
  );

  if (!valid || request.body.actor !== remoteActor.uri) return null;
  return remoteActor;
}

export default async function inboxRoutes(fastify: FastifyInstance) {
  // Person inbox (rate-limited: 30 req/min per IP)
  fastify.post<{ Params: { username: string }; Body: APActivity }>(
    '/users/:username/inbox',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const [localActor] = await fastify.db
        .select()
        .from(actors)
        .where(
          and(
            eq(actors.preferredUsername, request.params.username),
            eq(actors.local, true),
            eq(actors.type, 'Person'),
          ),
        )
        .limit(1);

      if (!localActor) return reply.status(404).send({ error: 'Actor not found' });

      const remoteActor = await verifyInboxRequest(fastify, request);
      if (!remoteActor) return reply.status(401).send({ error: 'Signature verification failed' });

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      await routeActivity(fastify, localActor, remoteActor, request.body, protocol, config.domain);
      return reply.status(202).send();
    },
  );

  // Group inbox (rate-limited: 30 req/min per IP)
  fastify.post<{ Params: { slug: string }; Body: APActivity }>(
    '/groups/:slug/inbox',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Match group by URI prefix (slug may contain UUID suffix)
      const allGroups = await fastify.db
        .select()
        .from(actors)
        .where(and(eq(actors.type, 'Group'), eq(actors.local, true)));

      const localActor = allGroups.find((g) =>
        g.preferredUsername === request.params.slug ||
        g.uri.includes(`/groups/${request.params.slug}`),
      );

      if (!localActor) return reply.status(404).send({ error: 'Group not found' });

      const remoteActor = await verifyInboxRequest(fastify, request);
      if (!remoteActor) return reply.status(401).send({ error: 'Signature verification failed' });

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      await routeActivity(fastify, localActor, remoteActor, request.body, protocol, config.domain);
      return reply.status(202).send();
    },
  );

  // Shared inbox (instance-level, rate-limited: 60 req/min per IP)
  fastify.post<{ Body: APActivity }>('/inbox', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const remoteActor = await verifyInboxRequest(fastify, request);
    if (!remoteActor) return reply.status(401).send({ error: 'Signature verification failed' });

    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';

    // For shared inbox, determine the target actor from to/cc fields
    // For now, just process the activity without a specific local target
    await routeActivity(fastify, null, remoteActor, request.body, protocol, config.domain);
    return reply.status(202).send();
  });
}

async function routeActivity(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect | null,
  remoteActor: typeof actors.$inferSelect,
  body: APActivity,
  protocol: string,
  domain: string,
) {
  switch (body.type) {
    case 'Follow':
      if (localActor) await handleFollow(fastify, localActor, remoteActor, body, protocol, domain);
      break;
    case 'Accept':
      await handleAccept(fastify, remoteActor, body);
      break;
    case 'Undo':
      if (localActor) await handleUndo(fastify, localActor, remoteActor, body);
      break;
    case 'Create':
      await handleCreate(fastify, remoteActor, body);
      break;
    case 'Delete':
      await handleDelete(fastify, remoteActor, body);
      break;
    case 'Update':
      await handleUpdate(fastify, remoteActor, body);
      break;
    case 'Read':
      await handleRead(fastify, remoteActor, body);
      break;
    default:
      fastify.log.info({ type: body.type }, 'Unhandled activity type');
  }
}

async function handleFollow(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
  protocol: string,
  domain: string,
) {
  const db = fastify.db;

  // Person→Person Follow is a friend request — do NOT auto-accept.
  // Create a pending_in friendship row and notify the local user.
  if (localActor.type === 'Person') {
    const [existing] = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.ownerActorId, localActor.id), eq(friendships.otherActorId, remoteActor.id)))
      .limit(1);

    if (existing) {
      // If we already have a pending_out row (we sent them a request first),
      // treat the incoming Follow as reciprocation → immediate accepted on both sides.
      if (existing.state === 'pending_out') {
        await db
          .update(friendships)
          .set({ state: 'accepted', updatedAt: new Date() })
          .where(eq(friendships.id, existing.id));
      }
      return;
    }

    const [created] = await db
      .insert(friendships)
      .values({
        ownerActorId: localActor.id,
        otherActorId: remoteActor.id,
        state: 'pending_in',
      })
      .returning();

    fastify.broadcastToActor(localActor.id, {
      type: 'friend:request',
      payload: {
        friendship: {
          id: created.id,
          state: 'pending_in',
          other: toAuthorView(remoteActor),
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        },
      },
    });

    fastify.log.info(
      { requester: remoteActor.uri, target: localActor.uri },
      'Friend request received',
    );
    return;
  }

  // Group follow (server join) — preserve existing auto-accept behavior.
  if (!localActor.followersUri) return;

  await db
    .insert(collectionItems)
    .values({
      collectionUri: localActor.followersUri,
      itemUri: remoteActor.uri,
      itemId: remoteActor.id,
    })
    .onConflictDoNothing();

  await db
    .insert(activities)
    .values({
      uri: activity.id ?? `${protocol}://${domain}/activities/${crypto.randomUUID()}`,
      type: 'Follow',
      actorId: remoteActor.id,
      objectUri: localActor.uri,
    })
    .onConflictDoNothing({ target: activities.uri });

  const actorWithKeys = await ensureActorKeys(db, localActor);
  if (!actorWithKeys.privateKeyPem) return;

  const acceptUri = `${protocol}://${domain}/activities/${crypto.randomUUID()}`;
  const accept = serializeActivity(acceptUri, 'Accept', localActor.uri, activity, [remoteActor.uri], []);

  await enqueueDelivery(db, accept, remoteActor.inboxUri, localActor.id);

  fastify.log.info({ follower: remoteActor.uri, followed: localActor.uri }, 'Follow accepted');
}

async function handleAccept(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  // Expect the inner object to be the Follow activity we previously sent.
  // Identify our local pending_out friendship row by (ownerActorId, otherActorId).
  const inner = activity.object;
  const innerType = typeof inner === 'string' ? null : inner?.type;
  if (innerType !== 'Follow') return;

  // The Follow's `actor` is us (local), `object` is the remote.
  const innerActor = typeof inner === 'string' ? null : (inner as { actor?: string }).actor;
  if (!innerActor) return;

  const [localSender] = await fastify.db
    .select()
    .from(actors)
    .where(and(eq(actors.uri, innerActor), eq(actors.local, true)))
    .limit(1);
  if (!localSender) return;

  const [row] = await fastify.db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.ownerActorId, localSender.id),
        eq(friendships.otherActorId, remoteActor.id),
      ),
    )
    .limit(1);
  if (!row || row.state !== 'pending_out') return;

  const now = new Date();
  const [updated] = await fastify.db
    .update(friendships)
    .set({ state: 'accepted', updatedAt: now })
    .where(eq(friendships.id, row.id))
    .returning();

  fastify.broadcastToActor(localSender.id, {
    type: 'friend:accepted',
    payload: {
      friendship: {
        id: updated.id,
        state: 'accepted',
        other: toAuthorView(remoteActor),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    },
  });

  fastify.log.info(
    { sender: localSender.uri, target: remoteActor.uri },
    'Friend request accepted (remote)',
  );
}

async function handleUndo(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const innerObject = activity.object;
  const innerType = typeof innerObject === 'string' ? null : innerObject?.type;

  if (innerType === 'Follow') {
    // Person → Person Undo: remove any friendship row owned by the local user
    // with the remote as other.
    if (localActor.type === 'Person') {
      const [row] = await fastify.db
        .select()
        .from(friendships)
        .where(
          and(
            eq(friendships.ownerActorId, localActor.id),
            eq(friendships.otherActorId, remoteActor.id),
          ),
        )
        .limit(1);

      if (row) {
        await fastify.db.delete(friendships).where(eq(friendships.id, row.id));
        fastify.broadcastToActor(localActor.id, {
          type: 'friend:removed',
          payload: { friendshipId: row.id },
        });
        fastify.log.info(
          { unfriended: remoteActor.uri, from: localActor.uri },
          'Friend Undo processed',
        );
      }
      return;
    }

    // Group Undo (server leave) — remove from followers collection.
    if (localActor.followersUri) {
      await fastify.db
        .delete(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, localActor.followersUri),
            eq(collectionItems.itemUri, remoteActor.uri),
          ),
        );
      fastify.log.info({ follower: remoteActor.uri, unfollowed: localActor.uri }, 'Undo Follow');
    }
  }
}

/**
 * Look up (or create) a local DM collection between a local Person and a remote actor.
 * Returns the local DM object id.
 */
async function findOrCreateDM(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect,
  remoteActor: typeof actors.$inferSelect,
): Promise<{ dmId: string; isNew: boolean }> {
  const db = fastify.db;

  // Search for an existing DM containing both actors
  const localMemberships = await db
    .select({ collectionUri: collectionItems.collectionUri })
    .from(collectionItems)
    .where(eq(collectionItems.itemUri, localActor.uri));

  for (const m of localMemberships) {
    const [otherEntry] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, m.collectionUri),
          eq(collectionItems.itemUri, remoteActor.uri),
        ),
      )
      .limit(1);
    if (!otherEntry) continue;

    const [channel] = await db
      .select()
      .from(objects)
      .where(eq(objects.uri, m.collectionUri))
      .limit(1);
    if (!channel) continue;
    const props = channel.properties as Record<string, unknown> | null;
    if (channel.belongsTo === null && props?.isDM) {
      return { dmId: channel.id, isNew: false };
    }
  }

  // Create a new local DM collection
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const dmUri = `${protocol}://${config.domain}/dms/${crypto.randomUUID()}`;

  const [channel] = await db
    .insert(objects)
    .values({
      uri: dmUri,
      type: 'OrderedCollection',
      belongsTo: null,
      properties: { name: null, isDM: true },
    })
    .returning();

  await db.insert(collectionItems).values([
    {
      collectionUri: channel.uri,
      collectionId: channel.id,
      itemUri: localActor.uri,
      itemId: localActor.id,
    },
    {
      collectionUri: channel.uri,
      collectionId: channel.id,
      itemUri: remoteActor.uri,
      itemId: remoteActor.id,
    },
  ]);

  return { dmId: channel.id, isNew: true };
}

async function handleCreate(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const obj = activity.object;
  if (typeof obj === 'string') {
    // Object is a URI reference — resolve it
    await resolveObject(fastify.db, obj);
  } else if (obj?.type === 'Note' && obj.id) {
    const toList = (obj.to as string[]) ?? [];
    const isPublic = toList.includes('https://www.w3.org/ns/activitystreams#Public');

    // Detect DM: non-public, addressed to a local Person
    let localDMId: string | null = null;
    let dmIsNew = false;
    let dmLocalRecipient: typeof actors.$inferSelect | null = null;
    if (!isPublic) {
      for (const uri of toList) {
        const [target] = await fastify.db
          .select()
          .from(actors)
          .where(and(eq(actors.uri, uri), eq(actors.local, true), eq(actors.type, 'Person')))
          .limit(1);
        if (target) {
          const result = await findOrCreateDM(fastify, target, remoteActor);
          localDMId = result.dmId;
          dmIsNew = result.isNew;
          dmLocalRecipient = target;
          break;
        }
      }
    }

    // Extract Babelr-custom encryption fields
    const noteProps: Record<string, unknown> = {};
    if ((obj as Record<string, unknown>).babelrEncrypted) noteProps.encrypted = true;
    if ((obj as Record<string, unknown>).babelrIv) {
      noteProps.iv = (obj as Record<string, unknown>).babelrIv;
    }
    if ((obj as Record<string, unknown>).babelrAttachments) {
      noteProps.attachments = (obj as Record<string, unknown>).babelrAttachments;
    }

    const [stored] = await fastify.db
      .insert(objects)
      .values({
        uri: obj.id,
        type: 'Note',
        attributedTo: remoteActor.id,
        content: obj.content ?? null,
        context: localDMId,
        to: toList,
        cc: (obj.cc as string[]) ?? [],
        published: obj.published ? new Date(obj.published as string) : new Date(),
        ...(Object.keys(noteProps).length > 0 && { properties: noteProps }),
      })
      .onConflictDoNothing({ target: objects.uri })
      .returning();

    // Broadcast to locally-connected DM participants
    if (localDMId && stored) {
      const messageView = {
        id: stored.id,
        content: stored.content ?? '',
        channelId: localDMId,
        authorId: remoteActor.id,
        published: stored.published.toISOString(),
        ...(Object.keys(noteProps).length > 0 && { properties: noteProps }),
      };
      const authorView = {
        id: remoteActor.id,
        preferredUsername: remoteActor.preferredUsername,
        displayName: remoteActor.displayName,
        avatarUrl: ((remoteActor.properties as Record<string, unknown> | null)?.avatarUrl as string) ?? null,
      };
      fastify.broadcastToChannel(localDMId, {
        type: 'message:new',
        payload: { message: messageView, author: authorView },
      });

      // If this is a brand-new DM, push conversation:new to the recipient
      // so their sidebar updates without a reload
      if (dmIsNew && dmLocalRecipient) {
        const localAuthorView = {
          id: dmLocalRecipient.id,
          preferredUsername: dmLocalRecipient.preferredUsername,
          displayName: dmLocalRecipient.displayName,
          avatarUrl:
            ((dmLocalRecipient.properties as Record<string, unknown> | null)?.avatarUrl as string) ??
            null,
        };
        fastify.broadcastToActor(dmLocalRecipient.id, {
          type: 'conversation:new',
          payload: {
            conversation: {
              id: localDMId,
              participants: [localAuthorView, authorView],
              lastMessage: messageView,
            },
          },
        });
      }
    }
  }

  // Log the activity
  if (activity.id) {
    await fastify.db
      .insert(activities)
      .values({
        uri: activity.id,
        type: 'Create',
        actorId: remoteActor.id,
        objectUri: typeof obj === 'string' ? obj : (obj?.id ?? ''),
      })
      .onConflictDoNothing({ target: activities.uri });
  }

  fastify.log.info({ actor: remoteActor.uri, type: 'Create' }, 'Remote Create processed');
}

async function handleRead(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity & { published?: string },
) {
  const objectUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectUri) return;

  // Look up the referenced Note — it should be one we sent (and therefore stored locally)
  const [note] = await fastify.db.select().from(objects).where(eq(objects.uri, objectUri)).limit(1);
  if (!note?.context) return;

  // Find the DM collection this Note belongs to
  const [dm] = await fastify.db
    .select()
    .from(objects)
    .where(eq(objects.id, note.context))
    .limit(1);
  if (!dm) return;
  const dmProps = (dm.properties as Record<string, unknown> | null) ?? {};
  if (!dmProps.isDM) return;

  const lastReadAt = activity.published ?? new Date().toISOString();
  const readBy = { ...((dmProps.readBy as Record<string, string> | undefined) ?? {}) };
  readBy[remoteActor.uri] = lastReadAt;

  await fastify.db
    .update(objects)
    .set({ properties: { ...dmProps, readBy } })
    .where(eq(objects.id, dm.id));

  // Notify the local author of the note so their UI updates
  if (note.attributedTo) {
    fastify.broadcastToActor(note.attributedTo, {
      type: 'dm:read',
      payload: { dmId: dm.id, actorUri: remoteActor.uri, lastReadAt },
    });
  }

  fastify.log.info({ reader: remoteActor.uri, dmId: dm.id }, 'Remote DM Read processed');
}

async function handleDelete(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const objectUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectUri) return;

  // Find local copy and tombstone it
  const [obj] = await fastify.db
    .select()
    .from(objects)
    .where(eq(objects.uri, objectUri))
    .limit(1);

  if (obj && obj.attributedTo === remoteActor.id) {
    await fastify.db
      .update(objects)
      .set({ type: 'Tombstone', content: null, updated: new Date() })
      .where(eq(objects.id, obj.id));

    fastify.log.info({ objectUri }, 'Remote Delete processed (tombstoned)');
  }
}

async function handleUpdate(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const obj = activity.object;
  if (typeof obj === 'string' || !obj?.id) return;

  const [existing] = await fastify.db
    .select()
    .from(objects)
    .where(eq(objects.uri, obj.id))
    .limit(1);

  if (existing && existing.attributedTo === remoteActor.id) {
    await fastify.db
      .update(objects)
      .set({
        content: obj.content ?? existing.content,
        updated: new Date(),
      })
      .where(eq(objects.id, existing.id));

    fastify.log.info({ objectUri: obj.id }, 'Remote Update processed');
  }
}
