// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { serializeOrderedCollection } from './jsonld.ts';

async function getActorByUsername(fastify: FastifyInstance, username: string) {
  const [actor] = await fastify.db
    .select()
    .from(actors)
    .where(
      and(
        eq(actors.preferredUsername, username),
        eq(actors.local, true),
        eq(actors.type, 'Person'),
      ),
    )
    .limit(1);
  return actor ?? null;
}

export default async function collectionRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { username: string } }>(
    '/users/:username/followers',
    async (request, reply) => {
      const actor = await getActorByUsername(fastify, request.params.username);
      if (!actor || !actor.followersUri) {
        return reply.status(404).send({ error: 'Actor not found' });
      }

      const [count] = await fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, actor.followersUri));

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeOrderedCollection(actor.followersUri, count?.count ?? 0);
    },
  );

  fastify.get<{ Params: { username: string } }>(
    '/users/:username/following',
    async (request, reply) => {
      const actor = await getActorByUsername(fastify, request.params.username);
      if (!actor || !actor.followingUri) {
        return reply.status(404).send({ error: 'Actor not found' });
      }

      const [count] = await fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, actor.followingUri));

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeOrderedCollection(actor.followingUri, count?.count ?? 0);
    },
  );

  // Group followers
  fastify.get<{ Params: { slug: string } }>(
    '/groups/:slug/followers',
    async (request, reply) => {
      const allGroups = await fastify.db
        .select()
        .from(actors)
        .where(and(eq(actors.type, 'Group'), eq(actors.local, true)));

      const actor = allGroups.find((g) =>
        g.preferredUsername === request.params.slug ||
        g.uri.includes(`/groups/${request.params.slug}`),
      );

      if (!actor?.followersUri) {
        return reply.status(404).send({ error: 'Group not found' });
      }

      const [count] = await fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, actor.followersUri));

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeOrderedCollection(actor.followersUri, count?.count ?? 0);
    },
  );

  // Group channels — public (non-private) channels belonging to
  // a Group actor. Used by remote instances during join-remote to
  // discover what channels exist and create local shadow objects.
  // Not ActivityPub-standard but follows the same collection shape.
  fastify.get<{ Params: { slug: string } }>(
    '/groups/:slug/channels',
    async (request, reply) => {
      const allGroups = await fastify.db
        .select()
        .from(actors)
        .where(and(eq(actors.type, 'Group'), eq(actors.local, true)));

      const actor = allGroups.find((g) =>
        g.preferredUsername === request.params.slug ||
        g.uri.includes(`/groups/${request.params.slug}`),
      );

      if (!actor) {
        return reply.status(404).send({ error: 'Group not found' });
      }

      const channels = await fastify.db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.type, 'OrderedCollection'),
            eq(objects.belongsTo, actor.id),
          ),
        );

      // Expose only public channels; private channels require
      // membership and should not leak to remote instances.
      const publicChannels = channels
        .filter((ch) => {
          const props = ch.properties as Record<string, unknown> | null;
          return !props?.isPrivate && !props?.isDM && !props?.isEventChat;
        })
        .map((ch) => {
          const props = ch.properties as Record<string, unknown> | null;
          return {
            uri: ch.uri,
            name: (props?.name as string) ?? 'unnamed',
            channelType: (props?.channelType as string) ?? 'text',
            ...(props?.topic ? { topic: props.topic as string } : {}),
            ...(props?.category ? { category: props.category as string } : {}),
          };
        });

      reply.header('Content-Type', 'application/json; charset=utf-8');
      return { channels: publicChannels };
    },
  );
}
