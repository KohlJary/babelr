// SPDX-License-Identifier: Hippocratic-3.0
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import './types.ts';
import { createDb } from './db/index.ts';
import { loadConfig } from './config.ts';
import authPlugin from './plugins/auth.ts';
import healthRoutes from './routes/health.ts';
import authRoutes from './routes/auth.ts';

export async function buildApp() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const app = Fastify({
    logger: true,
  });

  // Decorate with db and config
  app.register(
    fp(
      async (fastify) => {
        fastify.decorate('db', db);
        fastify.decorate('config', config);
      },
      { name: 'db' },
    ),
  );

  // The config-plugin is the same registration, just needs the name for dependency ordering
  app.register(
    fp(
      async () => {
        // config already decorated above
      },
      { name: 'config-plugin' },
    ),
  );

  // Plugins
  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);

  return app;
}
