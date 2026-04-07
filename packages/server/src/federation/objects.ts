// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import { serializeNote } from './jsonld.ts';

export default async function objectRoute(fastify: FastifyInstance) {
  fastify.get<{ Params: { objectId: string } }>(
    '/objects/:objectId',
    async (request, reply) => {
      const [obj] = await fastify.db
        .select()
        .from(objects)
        .where(eq(objects.id, request.params.objectId))
        .limit(1);

      if (!obj) {
        return reply.status(404).send({ error: 'Object not found' });
      }

      // Only serve local objects (check URI matches our domain)
      const config = fastify.config;
      if (!obj.uri.includes(config.domain)) {
        return reply.status(404).send({ error: 'Object not found' });
      }

      // Resolve author URI
      let actorUri = '';
      if (obj.attributedTo) {
        const [author] = await fastify.db
          .select()
          .from(actors)
          .where(eq(actors.id, obj.attributedTo))
          .limit(1);
        if (author) actorUri = author.uri;
      }

      if (obj.type === 'Note') {
        reply.header('Content-Type', 'application/activity+json; charset=utf-8');
        return serializeNote(obj, actorUri);
      }

      // For other types, return minimal AP representation
      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: obj.uri,
        type: obj.type,
      };
    },
  );
}
