// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';

async function seedPlugin(fastify: FastifyInstance) {
  fastify.addHook('onReady', async () => {
    const db = fastify.db;
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const serverUri = `${protocol}://${config.domain}/groups/babelr`;
    const channelUri = `${protocol}://${config.domain}/channels/general`;

    // Upsert the default "Babelr" server (Group actor)
    let [server] = await db
      .select()
      .from(actors)
      .where(eq(actors.uri, serverUri))
      .limit(1);

    if (!server) {
      [server] = await db
        .insert(actors)
        .values({
          type: 'Group',
          preferredUsername: 'babelr',
          displayName: 'Babelr',
          summary: 'Default server',
          uri: serverUri,
          inboxUri: `${serverUri}/inbox`,
          outboxUri: `${serverUri}/outbox`,
          followersUri: `${serverUri}/followers`,
          followingUri: `${serverUri}/following`,
          local: true,
          properties: {},
        })
        .returning();
    }

    // Upsert the default "general" channel, attached to the server
    const [existingChannel] = await db
      .select()
      .from(objects)
      .where(eq(objects.uri, channelUri))
      .limit(1);

    if (existingChannel) {
      // Migrate: ensure it belongs to the server
      if (!existingChannel.belongsTo) {
        await db
          .update(objects)
          .set({ belongsTo: server.id })
          .where(eq(objects.id, existingChannel.id));
      }
    } else {
      await db.insert(objects).values({
        uri: channelUri,
        type: 'OrderedCollection',
        belongsTo: server.id,
        properties: { name: 'general' },
      });
    }

    fastify.log.info('Default server and channel seeded');
  });
}

export default fp(seedPlugin, {
  name: 'seed',
  dependencies: ['db'],
});
