// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { serializeActor } from './jsonld.ts';
import { ensureActorKeys } from './keys.ts';

export default async function actorRoutes(fastify: FastifyInstance) {
  // Person actor profile
  fastify.get<{ Params: { username: string } }>(
    '/users/:username',
    async (request, reply) => {
      const [actor] = await fastify.db
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

      if (!actor) {
        return reply.status(404).send({ error: 'Actor not found' });
      }

      const actorWithKeys = await ensureActorKeys(fastify.db, actor);
      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeActor(actorWithKeys);
    },
  );

  // Group actor profile
  fastify.get<{ Params: { slug: string } }>(
    '/groups/:slug',
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

      const actorWithKeys = await ensureActorKeys(fastify.db, actor);
      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeActor(actorWithKeys);
    },
  );
}
