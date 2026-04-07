// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { serializeActor } from './jsonld.ts';
import { ensureActorKeys } from './keys.ts';

export default async function actorRoute(fastify: FastifyInstance) {
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

      // Ensure keypair exists for AP profile
      const actorWithKeys = await ensureActorKeys(fastify.db, actor);

      reply.header('Content-Type', 'application/activity+json; charset=utf-8');
      return serializeActor(actorWithKeys);
    },
  );
}
