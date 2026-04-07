// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';

export default async function webfingerRoute(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { resource?: string } }>(
    '/.well-known/webfinger',
    async (request, reply) => {
      const { resource } = request.query;
      if (!resource) {
        return reply.status(400).send({ error: 'resource parameter is required' });
      }

      // Parse acct:username@domain
      const match = resource.match(/^acct:([^@]+)@(.+)$/);
      if (!match) {
        return reply.status(400).send({ error: 'Invalid resource format' });
      }

      const [, username, domain] = match;

      if (domain !== fastify.config.domain) {
        return reply.status(404).send({ error: 'Unknown domain' });
      }

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

      if (!actor) {
        return reply.status(404).send({ error: 'Actor not found' });
      }

      reply.header('Content-Type', 'application/jrd+json');
      return {
        subject: `acct:${username}@${domain}`,
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actor.uri,
          },
        ],
      };
    },
  );
}
