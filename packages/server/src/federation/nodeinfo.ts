// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';

export default async function nodeinfoRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  // NodeInfo discovery
  fastify.get('/.well-known/nodeinfo', async (_request, reply) => {
    reply.header('Content-Type', 'application/json');
    return {
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: `${protocol}://${config.domain}/nodeinfo/2.1`,
        },
      ],
    };
  });

  // NodeInfo 2.1
  fastify.get('/nodeinfo/2.1', async (_request, reply) => {
    const [userCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(actors)
      .where(eq(actors.local, true));

    const [postCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(objects)
      .where(eq(objects.type, 'Note'));

    reply.header('Content-Type', 'application/json; charset=utf-8');
    return {
      version: '2.1',
      software: {
        name: 'babelr',
        version: '0.1.0',
        repository: 'https://github.com/KohlJary/babelr',
      },
      protocols: ['activitypub'],
      usage: {
        users: {
          total: userCount?.count ?? 0,
        },
        localPosts: postCount?.count ?? 0,
      },
      openRegistrations: true,
      metadata: {
        nodeName: 'Babelr',
        nodeDescription: 'Federated chat with tone-preserving LLM translation',
        features: [
          'tone-preserving-translation',
          'e2e-encrypted-dms',
          'browser-local-inference',
          'activitypub-federation',
        ],
      },
    };
  });
}
