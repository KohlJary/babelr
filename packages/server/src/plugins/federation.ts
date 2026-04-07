// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import '../types.ts';
import webfingerRoute from '../federation/webfinger.ts';
import actorRoutes from '../federation/actor.ts';
import inboxRoutes from '../federation/inbox.ts';
import outboxRoute from '../federation/outbox.ts';
import collectionRoutes from '../federation/collections.ts';
import objectRoute from '../federation/objects.ts';
import { startQueueProcessor } from '../federation/delivery.ts';

async function federationPlugin(fastify: FastifyInstance) {
  await fastify.register(webfingerRoute);
  await fastify.register(actorRoutes);
  await fastify.register(inboxRoutes);
  await fastify.register(outboxRoute);
  await fastify.register(collectionRoutes);
  await fastify.register(objectRoute);

  // Start the delivery queue processor
  startQueueProcessor(fastify);

  fastify.log.info('Federation plugin loaded');
}

export default fp(federationPlugin, {
  name: 'federation',
  dependencies: ['db', 'config-plugin'],
});
