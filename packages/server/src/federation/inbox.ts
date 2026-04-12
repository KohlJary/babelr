// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { friendships } from '../db/schema/friendships.ts';
import { reactions } from '../db/schema/reactions.ts';
import { wikiPages } from '../db/schema/wiki.ts';
import { events } from '../db/schema/events.ts';
import { toAuthorView } from '../routes/channels.ts';
import { verifySignatureFromParts, getKeyIdFromSignature } from './signatures.ts';
import { resolveActor, resolveActorByKeyId, resolveObject } from './resolve.ts';
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
  const headerParts = {
    host: (request.headers.host as string) ?? '',
    date: (request.headers.date as string) ?? '',
    digest: (request.headers.digest as string) ?? '',
  };

  // Try with cached key first.
  const remoteActor = await resolveActorByKeyId(fastify.db, keyId);
  if (!remoteActor) return null;

  const tryVerify = (actor: typeof remoteActor) => {
    const apPublicKey = (actor.properties as Record<string, unknown>)?.apPublicKey as
      | { publicKeyPem?: string }
      | undefined;
    if (!apPublicKey?.publicKeyPem) return false;
    return verifySignatureFromParts(
      apPublicKey.publicKeyPem,
      signatureHeader,
      request.method,
      request.url,
      headerParts,
    );
  };

  let valid = tryVerify(remoteActor);
  let actor = remoteActor;

  // If verification fails, the cached key may be stale (the remote
  // rotated keys, or the actor was cached before keys were generated).
  // Refetch the actor profile to get the current key and retry once.
  if (!valid) {
    const actorUri = keyId.split('#')[0];
    const refreshed = await resolveActor(fastify.db, actorUri, true);
    if (refreshed && refreshed.id === remoteActor.id) {
      valid = tryVerify(refreshed);
      actor = refreshed;
    }
  }

  if (!valid || request.body.actor !== actor.uri) return null;
  return actor;
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
    case 'Like':
      await handleLike(fastify, remoteActor, body);
      break;
    case 'Add':
      await handleAdd(fastify, localActor, remoteActor, body);
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

  if (innerType === 'Like') {
    // Undo a reaction. The inner Like's object carries the Note URI
    // and emoji. Resolve the author — for Group-relayed Undos, the
    // remoteActor is the Group, but the inner Like's actor is the
    // person who originally reacted.
    const innerActor = typeof innerObject === 'string' ? null : (innerObject as Record<string, unknown>)?.actor as string | undefined;
    const innerObj = typeof innerObject === 'string' ? null : (innerObject as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
    const noteUri = innerObj?.id as string | undefined;
    const emoji = innerObj?.emoji as string | undefined;
    if (!noteUri || !emoji) return;

    let reactorId = remoteActor.id;
    if (innerActor && innerActor !== remoteActor.uri) {
      const resolved = await resolveActor(fastify.db, innerActor);
      if (resolved) reactorId = resolved.id;
    }

    const [note] = await fastify.db
      .select({ id: objects.id, context: objects.context })
      .from(objects)
      .where(eq(objects.uri, noteUri))
      .limit(1);
    if (!note) return;

    await fastify.db
      .delete(reactions)
      .where(and(eq(reactions.objectId, note.id), eq(reactions.actorId, reactorId), eq(reactions.emoji, emoji)));

    if (note.context) {
      fastify.broadcastToChannel(note.context, {
        type: 'reaction:remove',
        payload: { messageId: note.id, emoji, actorId: reactorId },
      });
    }
    fastify.log.info({ noteUri, emoji }, 'Remote Undo(Like) processed');
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

    // Resolve the Note's real author. For DMs and personal-fanout
    // deliveries, remoteActor IS the author. But for Group-relayed
    // messages, remoteActor is the Group and the Note's attributedTo
    // points at the actual person who wrote the message. Resolve
    // that person so the stored Note gets the right author.
    let noteAuthor = remoteActor;
    const noteAttributedTo = (obj as Record<string, unknown>).attributedTo as string | undefined;
    if (noteAttributedTo && noteAttributedTo !== remoteActor.uri) {
      const resolved = await resolveActor(fastify.db, noteAttributedTo);
      if (resolved) noteAuthor = resolved;
    }

    // For public channel messages, resolve the `context` URI from the
    // inbound Note to a local shadow channel. If the message references
    // a channel URI we already cached during join-remote, the Note gets
    // stored with the shadow's local id as its context — then the
    // existing message-list and WS subscription flows Just Work.
    let channelContextId: string | null = localDMId;
    if (!channelContextId && (obj as Record<string, unknown>).context) {
      const contextUri = (obj as Record<string, unknown>).context as string;
      const [shadow] = await fastify.db
        .select({ id: objects.id })
        .from(objects)
        .where(eq(objects.uri, contextUri))
        .limit(1);
      if (shadow) channelContextId = shadow.id;
    }

    // Resolve inReplyTo URI to a local object ID so the reply
    // attaches to the correct thread on the receiving instance.
    let localInReplyTo: string | null = null;
    const inReplyToUri = (obj as Record<string, unknown>).inReplyTo as string | undefined;
    if (inReplyToUri) {
      const [parent] = await fastify.db
        .select({ id: objects.id })
        .from(objects)
        .where(eq(objects.uri, inReplyToUri))
        .limit(1);
      if (parent) localInReplyTo = parent.id;
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

    // Preserve the message slug so [[msg:slug]] embeds resolve
    // on the receiving instance without a round-trip to the origin.
    const remoteSlug = (obj as Record<string, unknown>).babelrSlug as string | undefined;

    const [stored] = await fastify.db
      .insert(objects)
      .values({
        uri: obj.id,
        type: 'Note',
        attributedTo: noteAuthor.id,
        content: obj.content ?? null,
        context: channelContextId,
        inReplyTo: localInReplyTo,
        slug: remoteSlug ?? null,
        to: toList,
        cc: (obj.cc as string[]) ?? [],
        published: obj.published ? new Date(obj.published as string) : new Date(),
        ...(Object.keys(noteProps).length > 0 && { properties: noteProps }),
      })
      .onConflictDoNothing({ target: objects.uri })
      .returning();

    // Broadcast to locally-connected participants. For DMs this
    // targets the local DM collection; for federated channel
    // messages it targets the shadow channel's subscribers.
    if (channelContextId && stored) {
      const messageView = {
        id: stored.id,
        content: stored.content ?? '',
        channelId: channelContextId,
        authorId: noteAuthor.id,
        slug: stored.slug ?? null,
        published: stored.published.toISOString(),
        ...(Object.keys(noteProps).length > 0 && { properties: noteProps }),
      };
      const authorView = {
        id: noteAuthor.id,
        preferredUsername: noteAuthor.preferredUsername,
        displayName: noteAuthor.displayName,
        avatarUrl: ((noteAuthor.properties as Record<string, unknown> | null)?.avatarUrl as string) ?? null,
      };
      fastify.broadcastToChannel(channelContextId, {
        type: 'message:new',
        payload: { message: messageView, author: authorView },
      });

      // If this is a brand-new DM, push conversation:new to the recipient
      // so their sidebar updates without a reload
      if (dmIsNew && dmLocalRecipient && localDMId) {
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
  } else if (obj?.type === 'Article' && obj.id) {
    // Wiki page — create a shadow wiki_pages row on this instance.
    const objData = obj as Record<string, unknown>;
    const pageUri = obj.id as string;
    const pageSlug = (objData.slug as string) ?? '';
    const pageTitle = (objData.name as string) ?? 'Untitled';
    const pageContent = (objData.content as string) ?? '';
    const pageTags = Array.isArray(objData.tags) ? (objData.tags as string[]) : [];
    const groupUri = (objData.context as string) ?? '';

    // Find the cached remote Group that owns this wiki.
    let groupId: string | null = null;
    if (groupUri) {
      const [group] = await fastify.db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.uri, groupUri))
        .limit(1);
      if (group) groupId = group.id;
    }
    if (!groupId) groupId = remoteActor.type === 'Group' ? remoteActor.id : null;

    if (groupId && pageSlug) {
      // Resolve the author.
      let authorId = remoteActor.id;
      const attrTo = objData.attributedTo as string | undefined;
      if (attrTo && attrTo !== remoteActor.uri) {
        const resolved = await resolveActor(fastify.db, attrTo);
        if (resolved) authorId = resolved.id;
      }

      await fastify.db
        .insert(wikiPages)
        .values({
          uri: pageUri,
          serverId: groupId,
          slug: pageSlug,
          title: pageTitle,
          content: pageContent,
          tags: pageTags,
          createdById: authorId,
          lastEditedById: authorId,
        })
        .onConflictDoNothing();

      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: groupId, action: 'created', slug: pageSlug },
      });
      fastify.log.info({ pageUri, slug: pageSlug }, 'Remote Create(Article) processed');
    }
  } else if (obj?.type === 'Event' && obj.id) {
    // Calendar event — create a shadow event on this instance.
    const objData = obj as Record<string, unknown>;
    const eventUri = obj.id as string;
    const groupUri = (objData.context as string) ?? '';

    let groupId: string | null = null;
    if (groupUri) {
      const [group] = await fastify.db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.uri, groupUri))
        .limit(1);
      if (group) groupId = group.id;
    }
    if (!groupId) groupId = remoteActor.type === 'Group' ? remoteActor.id : null;

    if (groupId) {
      let authorId = remoteActor.id;
      const attrTo = objData.attributedTo as string | undefined;
      if (attrTo && attrTo !== remoteActor.uri) {
        const resolved = await resolveActor(fastify.db, attrTo);
        if (resolved) authorId = resolved.id;
      }

      // Create event chat collection
      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';
      const chatUri = `${protocol}://${config.domain}/events/${crypto.randomUUID()}/chat`;
      const [chatChannel] = await fastify.db
        .insert(objects)
        .values({
          uri: chatUri,
          type: 'OrderedCollection',
          belongsTo: null,
          properties: { name: objData.name ?? 'Event', isEventChat: true },
        })
        .returning();

      await fastify.db
        .insert(events)
        .values({
          uri: eventUri,
          ownerType: 'server',
          ownerId: groupId,
          createdById: authorId,
          slug: (objData.slug as string) ?? null,
          title: (objData.name as string) ?? 'Untitled Event',
          description: (objData.content as string) ?? null,
          startAt: new Date((objData.startTime as string) ?? new Date()),
          endAt: new Date((objData.endTime as string) ?? new Date()),
          location: (objData.location as string) ?? null,
          rrule: (objData.rrule as string) ?? null,
          eventChatId: chatChannel.id,
        })
        .onConflictDoNothing();

      fastify.log.info({ eventUri }, 'Remote Create(Event) processed');
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

async function handleLike(
  fastify: FastifyInstance,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const obj = activity.object;
  if (typeof obj === 'string' || !obj?.id) return;

  const noteUri = obj.id as string;
  const emoji = (obj as Record<string, unknown>).emoji as string | undefined;
  if (!emoji) return;

  // Resolve the actual reactor. For Group-relayed Likes, the outer
  // activity.actor is the Group (it signed the delivery) but the
  // inner object carries an `actor` field with the real person who
  // reacted. For direct person-signed Likes, remoteActor IS the
  // reactor and the inner actor field may be absent.
  let reactorId = remoteActor.id;
  const innerReactor = (obj as Record<string, unknown>).actor as string | undefined;
  if (innerReactor) {
    const resolved = await resolveActor(fastify.db, innerReactor);
    if (resolved) reactorId = resolved.id;
  }

  const [note] = await fastify.db
    .select({ id: objects.id, context: objects.context })
    .from(objects)
    .where(eq(objects.uri, noteUri))
    .limit(1);
  if (!note) return;

  // Upsert the reaction.
  await fastify.db
    .insert(reactions)
    .values({ objectId: note.id, actorId: reactorId, emoji })
    .onConflictDoNothing();

  // Broadcast to local WS subscribers.
  if (note.context) {
    // Look up the reactor for the author view.
    const [reactor] = await fastify.db
      .select()
      .from(actors)
      .where(eq(actors.id, reactorId))
      .limit(1);
    if (reactor) {
      fastify.broadcastToChannel(note.context, {
        type: 'reaction:add',
        payload: {
          messageId: note.id,
          emoji,
          actor: toAuthorView(reactor),
        },
      });
    }
  }

  fastify.log.info({ noteUri, emoji, reactor: reactorId }, 'Remote Like processed');
}

/**
 * Handle an Add activity — used when a remote server invites a local
 * user to a private channel. The activity's object carries the
 * channel metadata (URI, name, type, belongsTo) so we can create a
 * local shadow without a follow-up fetch. The `to` field addresses
 * the invited local actor.
 */
async function handleAdd(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect | null,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const obj = activity.object;
  if (typeof obj === 'string' || !obj) return;

  const objData = obj as Record<string, unknown>;
  if (objData.type !== 'OrderedCollection' || !objData.id) return;

  // Find the local user being invited (from the `to` field).
  const toList = activity.to ?? [];
  let targetActor = localActor;
  if (!targetActor) {
    for (const uri of toList) {
      const [local] = await fastify.db
        .select()
        .from(actors)
        .where(and(eq(actors.uri, uri), eq(actors.local, true)))
        .limit(1);
      if (local) { targetActor = local; break; }
    }
  }
  if (!targetActor) return;

  // Resolve the server Group that owns this channel. The belongsTo
  // field from the activity carries the Group's actor id on the
  // origin — look up our cached copy by matching the origin server.
  const belongsToId = objData.belongsTo as string | undefined;
  let localGroupId: string | null = null;
  if (belongsToId) {
    // Try to find a cached remote Group actor matching this id.
    const [group] = await fastify.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.type, 'Group'), eq(actors.local, false)))
      .limit(1);
    if (group) localGroupId = group.id;
  }

  // Create (or find) the shadow channel.
  const channelUri = objData.id as string;
  const [existing] = await fastify.db
    .select({ id: objects.id })
    .from(objects)
    .where(eq(objects.uri, channelUri))
    .limit(1);

  let shadowId: string;
  if (existing) {
    shadowId = existing.id;
  } else {
    const [created] = await fastify.db
      .insert(objects)
      .values({
        uri: channelUri,
        type: 'OrderedCollection',
        belongsTo: localGroupId,
        properties: {
          name: (objData.name as string) ?? 'unnamed',
          channelType: (objData.channelType as string) ?? 'text',
          isPrivate: true,
          ...(objData.topic ? { topic: objData.topic } : {}),
          ...(objData.category ? { category: objData.category } : {}),
        },
      })
      .returning();
    shadowId = created.id;
  }

  // Add the local user to the channel's membership.
  await fastify.db
    .insert(collectionItems)
    .values({
      collectionUri: channelUri,
      collectionId: shadowId,
      itemUri: targetActor.uri,
      itemId: targetActor.id,
    })
    .onConflictDoNothing();

  fastify.log.info(
    { channel: channelUri, user: targetActor.uri },
    'Remote channel invite (Add) processed',
  );
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

  // Check for event deletion.
  const [eventRow] = await fastify.db
    .select({ id: events.id, eventChatId: events.eventChatId })
    .from(events)
    .where(eq(events.uri, objectUri))
    .limit(1);
  if (eventRow) {
    await fastify.db.delete(events).where(eq(events.id, eventRow.id));
    await fastify.db.delete(objects).where(eq(objects.id, eventRow.eventChatId));
    fastify.log.info({ objectUri }, 'Remote Delete(Event) processed');
    return;
  }

  // Check for wiki page deletion first (Article URIs live in
  // wiki_pages, not objects).
  const [wikiPage] = await fastify.db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.uri, objectUri))
    .limit(1);
  if (wikiPage) {
    // Look up serverId before deleting for the WS broadcast.
    const [pageInfo] = await fastify.db
      .select({ serverId: wikiPages.serverId, slug: wikiPages.slug })
      .from(wikiPages)
      .where(eq(wikiPages.id, wikiPage.id))
      .limit(1);
    await fastify.db.delete(wikiPages).where(eq(wikiPages.id, wikiPage.id));
    if (pageInfo) {
      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: pageInfo.serverId, action: 'deleted', slug: pageInfo.slug },
      });
    }
    fastify.log.info({ objectUri }, 'Remote Delete(Article) processed');
    return;
  }

  // Find local copy and tombstone it. Accept if the remoteActor is
  // the author OR a Group that owns the channel (Group-relayed delete).
  const [obj] = await fastify.db
    .select()
    .from(objects)
    .where(eq(objects.uri, objectUri))
    .limit(1);

  if (!obj) return;

  const isAuthor = obj.attributedTo === remoteActor.id;
  const isOwnerGroup =
    remoteActor.type === 'Group' &&
    obj.context != null &&
    (await (async () => {
      const [ch] = await fastify.db
        .select({ belongsTo: objects.belongsTo })
        .from(objects)
        .where(eq(objects.id, obj.context!))
        .limit(1);
      return ch?.belongsTo === remoteActor.id;
    })());

  if (isAuthor || isOwnerGroup) {
    await fastify.db
      .update(objects)
      .set({ type: 'Tombstone', content: null, updated: new Date() })
      .where(eq(objects.id, obj.id));

    // Broadcast deletion to local WS subscribers.
    if (obj.context) {
      fastify.broadcastToChannel(obj.context, {
        type: 'message:deleted',
        payload: { messageId: obj.id, channelId: obj.context },
      });
    }

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

  // Actor update: the remote side's display name / avatar / bio
  // changed and they're telling us so we can overwrite the cached
  // row. The object id must match the sender's actor URI — we're
  // not letting a remote actor update anyone's profile but their
  // own.
  const innerType = (obj as { type?: string }).type;
  if (innerType === 'Person' || innerType === 'Group') {
    if (obj.id !== remoteActor.uri) {
      fastify.log.warn(
        { sender: remoteActor.uri, claimed: obj.id },
        'Rejected Update(Actor): sender does not own the actor being updated',
      );
      return;
    }

    const actorData = obj as Record<string, unknown>;
    const newProperties: Record<string, unknown> = {
      ...((remoteActor.properties as Record<string, unknown> | null) ?? {}),
    };

    // Key material if the remote re-served it.
    if (actorData.publicKey) newProperties.apPublicKey = actorData.publicKey;
    if (actorData.babelrEcdhKey) newProperties.publicKey = actorData.babelrEcdhKey;

    // Avatar — drizzle stores this under properties.avatarUrl.
    const icon = actorData.icon as unknown;
    if (icon) {
      if (typeof icon === 'string') {
        newProperties.avatarUrl = icon;
      } else if (typeof icon === 'object') {
        const i = icon as { url?: unknown; href?: unknown };
        if (typeof i.url === 'string') newProperties.avatarUrl = i.url;
        else if (typeof i.href === 'string') newProperties.avatarUrl = i.href;
      }
    }

    await fastify.db
      .update(actors)
      .set({
        displayName: (actorData.name as string | null) ?? null,
        summary: (actorData.summary as string | null) ?? null,
        properties: newProperties,
        updatedAt: new Date(),
      })
      .where(eq(actors.id, remoteActor.id));

    // Reload the updated row so we can push a fresh FriendshipView
    // to every local user who has this remote actor as a friend.
    // Without this WS push, currently-connected friends would see
    // stale data until they reload the page.
    const [refreshed] = await fastify.db
      .select()
      .from(actors)
      .where(eq(actors.id, remoteActor.id))
      .limit(1);

    if (refreshed) {
      const localFriends = await fastify.db
        .select()
        .from(friendships)
        .where(
          and(
            eq(friendships.otherActorId, refreshed.id),
            eq(friendships.state, 'accepted'),
          ),
        );

      const otherView = toAuthorView(refreshed);
      for (const f of localFriends) {
        fastify.broadcastToActor(f.ownerActorId, {
          type: 'friend:updated',
          payload: {
            friendship: {
              id: f.id,
              state: 'accepted',
              other: otherView,
              createdAt: f.createdAt.toISOString(),
              updatedAt: f.updatedAt.toISOString(),
            },
          },
        });
      }
    }

    fastify.log.info(
      { actor: remoteActor.uri, type: innerType },
      'Remote Update(Actor) processed',
    );
    return;
  }

  // Event update.
  if (innerType === 'Event') {
    if (!obj.id) return;
    const objData = obj as Record<string, unknown>;
    const [existing] = await fastify.db
      .select()
      .from(events)
      .where(eq(events.uri, obj.id as string))
      .limit(1);
    if (existing) {
      await fastify.db
        .update(events)
        .set({
          title: (objData.name as string) ?? existing.title,
          description: (objData.content as string) ?? existing.description,
          startAt: objData.startTime ? new Date(objData.startTime as string) : existing.startAt,
          endAt: objData.endTime ? new Date(objData.endTime as string) : existing.endAt,
          location: (objData.location as string) ?? existing.location,
          rrule: (objData.rrule as string) ?? existing.rrule,
          updatedAt: new Date(),
        })
        .where(eq(events.id, existing.id));
      fastify.log.info({ eventUri: obj.id }, 'Remote Update(Event) processed');
    }
    return;
  }

  // Article update (wiki page edited on the origin).
  if (innerType === 'Article') {
    if (!obj.id) return;
    const objData = obj as Record<string, unknown>;
    const [existing] = await fastify.db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.uri, obj.id as string))
      .limit(1);

    if (existing) {
      await fastify.db
        .update(wikiPages)
        .set({
          title: (objData.name as string) ?? existing.title,
          content: (objData.content as string) ?? existing.content,
          tags: Array.isArray(objData.tags) ? (objData.tags as string[]) : existing.tags,
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, existing.id));

      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: existing.serverId, action: 'updated', slug: existing.slug },
      });
      fastify.log.info({ pageUri: obj.id }, 'Remote Update(Article) processed');
    }
    return;
  }

  // Object update (e.g. Note edited). Accept the update if the
  // remoteActor is the Note's author OR a Group that owns the
  // channel the Note belongs to (Groups relay edits on behalf of
  // their members).
  const [existing] = await fastify.db
    .select()
    .from(objects)
    .where(eq(objects.uri, obj.id))
    .limit(1);

  if (!existing) return;

  const isAuthor = existing.attributedTo === remoteActor.id;
  const isOwnerGroup =
    remoteActor.type === 'Group' &&
    existing.context != null &&
    (await (async () => {
      const [ch] = await fastify.db
        .select({ belongsTo: objects.belongsTo })
        .from(objects)
        .where(eq(objects.id, existing.context!))
        .limit(1);
      return ch?.belongsTo === remoteActor.id;
    })());

  if (isAuthor || isOwnerGroup) {
    await fastify.db
      .update(objects)
      .set({
        content: obj.content ?? existing.content,
        updated: new Date(),
      })
      .where(eq(objects.id, existing.id));

    // Broadcast the edit to local WS subscribers so the UI updates.
    if (existing.context) {
      fastify.broadcastToChannel(existing.context, {
        type: 'message:updated',
        payload: {
          messageId: existing.id,
          channelId: existing.context,
          content: (obj.content as string) ?? existing.content ?? '',
          updatedAt: new Date().toISOString(),
        },
      });
    }

    fastify.log.info({ objectUri: obj.id }, 'Remote Update processed');
  }
}
