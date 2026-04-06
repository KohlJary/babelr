// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';

async function seedPlugin(fastify: FastifyInstance) {
  fastify.addHook('onReady', async () => {
    const db = fastify.db;
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const uri = `${protocol}://${config.domain}/channels/general`;

    // Upsert the default "general" channel
    await db
      .insert(objects)
      .values({
        uri,
        type: 'OrderedCollection',
        properties: { name: 'general' },
      })
      .onConflictDoNothing({ target: objects.uri });

    fastify.log.info('Default channel seeded');
  });
}

export default fp(seedPlugin, {
  name: 'seed',
  dependencies: ['db'],
});
