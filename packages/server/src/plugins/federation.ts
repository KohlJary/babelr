// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import '../types.ts';
import webfingerRoute from '../federation/webfinger.ts';
import actorRoute from '../federation/actor.ts';
import inboxRoute from '../federation/inbox.ts';
import outboxRoute from '../federation/outbox.ts';
import collectionRoutes from '../federation/collections.ts';
import objectRoute from '../federation/objects.ts';

async function federationPlugin(fastify: FastifyInstance) {
  await fastify.register(webfingerRoute);
  await fastify.register(actorRoute);
  await fastify.register(inboxRoute);
  await fastify.register(outboxRoute);
  await fastify.register(collectionRoutes);
  await fastify.register(objectRoute);

  fastify.log.info('Federation plugin loaded');
}

export default fp(federationPlugin, {
  name: 'federation',
  dependencies: ['db', 'config-plugin'],
});
