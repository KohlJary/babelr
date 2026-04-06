// SPDX-License-Identifier: Hippocratic-3.0
import type { Database } from './db/index.ts';
import type { Config } from './config.ts';
import type { actors } from './db/schema/actors.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
    createSession: (actorId: string, reply: import('fastify').FastifyReply) => Promise<string>;
    destroySession: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    actor?: typeof actors.$inferSelect;
  }
}
