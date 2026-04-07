// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
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
  // Person inbox
  fastify.post<{ Params: { username: string }; Body: APActivity }>(
    '/users/:username/inbox',
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

  // Group inbox
  fastify.post<{ Params: { slug: string }; Body: APActivity }>(
    '/groups/:slug/inbox',
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

  // Shared inbox (instance-level)
  fastify.post<{ Body: APActivity }>('/inbox', async (request, reply) => {
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

  // Auto-Accept
  const actorWithKeys = await ensureActorKeys(db, localActor);
  if (!actorWithKeys.privateKeyPem) return;

  const acceptUri = `${protocol}://${domain}/activities/${crypto.randomUUID()}`;
  const accept = serializeActivity(acceptUri, 'Accept', localActor.uri, activity, [remoteActor.uri], []);

  await enqueueDelivery(db, accept, remoteActor.inboxUri, localActor.id);

  fastify.log.info({ follower: remoteActor.uri, followed: localActor.uri }, 'Follow accepted');
}

async function handleUndo(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const innerObject = activity.object;
  const innerType = typeof innerObject === 'string' ? null : innerObject?.type;

  if (innerType === 'Follow' && localActor.followersUri) {
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
    // Inline Note — store directly
    await fastify.db
      .insert(objects)
      .values({
        uri: obj.id,
        type: 'Note',
        attributedTo: remoteActor.id,
        content: obj.content ?? null,
        to: (obj.to as string[]) ?? [],
        cc: (obj.cc as string[]) ?? [],
        published: obj.published ? new Date(obj.published as string) : new Date(),
      })
      .onConflictDoNothing({ target: objects.uri });
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
