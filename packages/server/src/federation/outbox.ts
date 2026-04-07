// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { activities } from '../db/schema/activities.ts';
import { objects } from '../db/schema/objects.ts';
import { serializeOrderedCollection, serializeOrderedCollectionPage, serializeNote, serializeActivity } from './jsonld.ts';

export default async function outboxRoutes(fastify: FastifyInstance) {
  // Person outbox
  fastify.get<{ Params: { username: string }; Querystring: { page?: string } }>(
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

      if (!actor) return reply.status(404).send({ error: 'Actor not found' });

      const [count] = await fastify.db
        .select({ count: sql<number>`count(*)::int` })
        .from(activities)
        .where(eq(activities.actorId, actor.id));

      const totalItems = count?.count ?? 0;

      // If no page param, return collection metadata
      if (!request.query.page) {
        reply.header('Content-Type', 'application/activity+json; charset=utf-8');
        return serializeOrderedCollection(
          actor.outboxUri,
          totalItems,
          `${actor.outboxUri}?page=1`,
        );
      }

      // Paginated items
      const activityRows = await fastify.db
        .select()
        .from(activities)
        .where(eq(activities.actorId, actor.id))
        .orderBy(desc(activities.published))
        .limit(20);

      const items = [];
      for (const act of activityRows) {
        // Resolve the object if it's a local Note
        let objectJson: unknown = act.objectUri;
        if (act.objectId) {
          const [obj] = await fastify.db
            .select()
            .from(objects)
            .where(eq(objects.id, act.objectId))
            .limit(1);
          if (obj && obj.type === 'Note') {
            objectJson = serializeNote(obj, actor.uri);
          }
        }

        items.push(
          serializeActivity(act.uri, act.type, actor.uri, objectJson, (act.to as string[]) ?? [], (act.cc as string[]) ?? []),
        );
      }

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeOrderedCollectionPage(
        `${actor.outboxUri}?page=1`,
        items,
        actor.outboxUri,
      );
    },
  );
}
