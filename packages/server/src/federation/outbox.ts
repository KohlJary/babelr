// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { activities } from '../db/schema/activities.ts';
import { serializeOrderedCollection } from './jsonld.ts';

export default async function outboxRoute(fastify: FastifyInstance) {
  fastify.get<{ Params: { username: string } }>(
    '/users/:username/outbox',
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

      const [count] = await fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(activities)
        .where(eq(activities.actorId, actor.id));

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeOrderedCollection(actor.outboxUri, count?.count ?? 0);
    },
  );
}
