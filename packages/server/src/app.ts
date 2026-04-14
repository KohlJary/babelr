// SPDX-License-Identifier: Hippocratic-3.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fp from 'fastify-plugin';
import './types.ts';
import { createDb } from './db/index.ts';
import { loadConfig } from './config.ts';
import authPlugin from './plugins/auth.ts';
import wsPlugin from './plugins/ws.ts';
import seedPlugin from './plugins/seed.ts';
import i18nSeedPlugin from './plugins/i18n-seed.ts';
import healthRoutes from './routes/health.ts';
import authRoutes from './routes/auth.ts';
import channelRoutes from './routes/channels.ts';
import wsRoutes from './routes/ws.ts';
import translateRoutes from './routes/translate.ts';
import serverRoutes from './routes/servers.ts';
import dmRoutes from './routes/dms.ts';
import friendsRoutes from './routes/friends.ts';
import i18nRoutes from './routes/i18n.ts';
import eventRoutes from './routes/events.ts';
import wikiRoutes from './routes/wiki.ts';
import roleRoutes from './routes/roles.ts';
import searchRoutes from './routes/search.ts';
import federationPlugin from './plugins/federation.ts';
import uploadRoutes from './routes/uploads.ts';
import fileRoutes from './routes/files.ts';
import wikiSeedPlugin from './plugins/wiki-seed.ts';
import embedRoutes from './routes/embeds.ts';
import auditRoutes from './routes/audit.ts';
import ssoRoutes from './routes/sso.ts';
import { initSfu, shutdownSfu } from './voice/sfu.ts';

export async function buildApp() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const isProduction = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
    },
    trustProxy: isProduction,
  });

  // Production error handler — no stack traces leaked
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error(error);
      reply.status(500).send({ error: 'Internal server error' });
    } else {
      reply.status(statusCode).send({ error: err.message ?? 'Error' });
    }
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

  app.register(
    fp(async () => {}, { name: 'config-plugin' }),
  );

  // CORS — locked to configured domain in production
  const allowedOrigins = isProduction
    ? [`https://${config.domain}`, `http://${config.domain}`]
    : true;

  await app.register(cookie);
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // ActivityPub servers POST to inboxes with `application/activity+json`
  // (or `application/ld+json`). Fastify's built-in JSON parser only
  // claims `application/json`, so without this every inbox delivery
  // would 415 before reaching the handler. Reuse Fastify's own JSON
  // parser implementation so the parsed body shape is identical to
  // what `application/json` routes receive.
  const jsonParser = app.getDefaultJsonParser('ignore', 'ignore');
  app.addContentTypeParser('application/activity+json', { parseAs: 'string' }, jsonParser);
  app.addContentTypeParser('application/ld+json', { parseAs: 'string' }, jsonParser);

  // Security headers. CORP must be `cross-origin` so federation peers
  // can load user-uploaded avatars and attachments served from this
  // instance (an <img> on bob's instance pointing at alice's instance
  // gets blocked otherwise, regardless of CORS). Helmet's default is
  // `same-origin` which is too strict for a federating system.
  await app.register(helmet, {
    contentSecurityPolicy: false, // CSP handled by Tauri for desktop; web uses default
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // File handling
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Uploads directory
  const uploadsDir = join(process.cwd(), isProduction ? 'uploads' : '../../uploads');
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Serve client build in production
  const clientDistDir = join(process.cwd(), isProduction ? '../client/dist' : '../../packages/client/dist');
  if (existsSync(clientDistDir)) {
    await app.register(fastifyStatic, {
      root: clientDistDir,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
    });
  }

  // Plugins
  await app.register(authPlugin);
  await app.register(wsPlugin);
  await app.register(seedPlugin);
  await app.register(i18nSeedPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(channelRoutes);
  await app.register(wsRoutes);
  await app.register(translateRoutes);
  await app.register(serverRoutes);
  await app.register(dmRoutes);
  await app.register(friendsRoutes);
  await app.register(i18nRoutes);
  await app.register(eventRoutes);
  await app.register(wikiRoutes);
  await app.register(roleRoutes);
  await app.register(searchRoutes);
  await app.register(federationPlugin);
  await app.register(uploadRoutes);
  await app.register(fileRoutes);
  await app.register(embedRoutes);
  await app.register(auditRoutes);
  await app.register(ssoRoutes);
  await app.register(wikiSeedPlugin);

  // SPA fallback — serve index.html for all non-API paths
  if (existsSync(clientDistDir)) {
    app.setNotFoundHandler((request, reply) => {
      // Don't serve HTML for API/federation/upload paths
      const path = request.url;
      if (
        path.startsWith('/auth/') ||
        path.startsWith('/servers') ||
        path.startsWith('/channels') ||
        path.startsWith('/dms') ||
        path.startsWith('/translate') ||
        path.startsWith('/upload') ||
        path.startsWith('/users/') ||
        path.startsWith('/groups/') ||
        path.startsWith('/objects/') ||
        path.startsWith('/inbox') ||
        path.startsWith('/ws') ||
        path.startsWith('/health') ||
        path.startsWith('/search') ||
        path.startsWith('/notifications') ||
        path.startsWith('/mentions') ||
        path.startsWith('/.well-known')
      ) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html', clientDistDir);
    });
  }

  await initSfu(config);
  app.addHook('onClose', async () => {
    await shutdownSfu();
  });

  return app;
}
