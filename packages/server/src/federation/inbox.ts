// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { verifySignatureFromParts, getKeyIdFromSignature } from './signatures.ts';
import { resolveActorByKeyId } from './resolve.ts';
import { deliverActivity } from './delivery.ts';
import { serializeActivity } from './jsonld.ts';
import { ensureActorKeys } from './keys.ts';

interface APActivity {
  id?: string;
  type: string;
  actor: string;
  object: string | { id?: string; type?: string; actor?: string; [key: string]: unknown };
  to?: string[];
  cc?: string[];
}

export default async function inboxRoute(fastify: FastifyInstance) {
  fastify.post<{ Params: { username: string }; Body: APActivity }>(
    '/users/:username/inbox',
    async (request, reply) => {
      const db = fastify.db;
      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      // Find local actor
      const [localActor] = await db
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

      if (!localActor) {
        return reply.status(404).send({ error: 'Actor not found' });
      }

      // Verify HTTP Signature
      const signatureHeader = request.headers.signature as string | undefined;
      if (!signatureHeader) {
        return reply.status(401).send({ error: 'Missing signature' });
      }

      const keyId = getKeyIdFromSignature(signatureHeader);
      const remoteActor = await resolveActorByKeyId(db, keyId);
      if (!remoteActor) {
        return reply.status(401).send({ error: 'Could not resolve signing actor' });
      }

      const apPublicKey = (remoteActor.properties as Record<string, unknown>)?.apPublicKey as
        | { publicKeyPem?: string }
        | undefined;
      if (!apPublicKey?.publicKeyPem) {
        return reply.status(401).send({ error: 'No public key available for verification' });
      }

      const valid = verifySignatureFromParts(
        apPublicKey.publicKeyPem,
        signatureHeader,
        request.method,
        request.url,
        {
          host: request.headers.host ?? '',
          date: request.headers.date ?? '',
          digest: request.headers.digest as string ?? '',
        },
      );

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Verify actor matches signature
      const body = request.body;
      if (body.actor !== remoteActor.uri) {
        return reply.status(401).send({ error: 'Actor does not match signature' });
      }

      // Route by activity type
      switch (body.type) {
        case 'Follow':
          await handleFollow(fastify, localActor, remoteActor, body, protocol, config.domain);
          break;

        case 'Undo':
          await handleUndo(fastify, localActor, remoteActor, body);
          break;

        default:
          fastify.log.info({ type: body.type }, 'Unhandled activity type');
      }

      return reply.status(202).send();
    },
  );
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

  // Add to followers (idempotent)
  await db
    .insert(collectionItems)
    .values({
      collectionUri: localActor.followersUri,
      itemUri: remoteActor.uri,
      itemId: remoteActor.id,
    })
    .onConflictDoNothing();

  // Log the Follow activity
  await db
    .insert(activities)
    .values({
      uri: activity.id ?? `${protocol}://${domain}/activities/${crypto.randomUUID()}`,
      type: 'Follow',
      actorId: remoteActor.id,
      objectUri: localActor.uri,
    })
    .onConflictDoNothing({ target: activities.uri });

  // Auto-Accept: send Accept back
  const actorWithKeys = await ensureActorKeys(db, localActor);
  if (!actorWithKeys.privateKeyPem) return;

  const acceptUri = `${protocol}://${domain}/activities/${crypto.randomUUID()}`;
  const accept = serializeActivity(
    acceptUri,
    'Accept',
    localActor.uri,
    activity,
    [remoteActor.uri],
    [],
  );

  await deliverActivity(
    actorWithKeys.privateKeyPem,
    localActor.uri,
    accept,
    remoteActor.inboxUri,
  );

  fastify.log.info(
    { follower: remoteActor.uri, followed: localActor.uri },
    'Follow accepted',
  );
}

async function handleUndo(
  fastify: FastifyInstance,
  localActor: typeof actors.$inferSelect,
  remoteActor: typeof actors.$inferSelect,
  activity: APActivity,
) {
  const db = fastify.db;
  const innerObject = activity.object;
  const innerType =
    typeof innerObject === 'string' ? null : innerObject?.type;

  if (innerType === 'Follow' && localActor.followersUri) {
    // Remove from followers
    await db
      .delete(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, localActor.followersUri),
          eq(collectionItems.itemUri, remoteActor.uri),
        ),
      );

    fastify.log.info(
      { follower: remoteActor.uri, unfollowed: localActor.uri },
      'Undo Follow processed',
    );
  }
}
