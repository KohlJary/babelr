// SPDX-License-Identifier: Hippocratic-3.0
import type { Database } from './db/index.ts';
import type { Config } from './config.ts';
import type { actors } from './db/schema/actors.ts';
import type { WsServerMessage } from '@babelr/shared';
import type { WebSocket } from 'ws';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
    createSession: (actorId: string, reply: import('fastify').FastifyReply) => Promise<string>;
    destroySession: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    broadcastToChannel: (channelId: string, message: WsServerMessage) => void;
    broadcastToActor: (actorId: string, message: WsServerMessage) => void;
    wsSubscribe: (ws: WebSocket, channelId: string) => void;
    wsUnsubscribe: (ws: WebSocket, channelId: string) => void;
    wsRemoveClient: (ws: WebSocket) => void;
    wsGetChannelSubs: (channelId: string) => Set<WebSocket>;
    wsRegisterActorConnection: (ws: WebSocket, actorId: string) => void;
  }

  interface FastifyRequest {
    actor?: typeof actors.$inferSelect;
  }
}
