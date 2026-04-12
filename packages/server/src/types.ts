// SPDX-License-Identifier: Hippocratic-3.0
import type { Database } from './db/index.ts';
import type { Config } from './config.ts';
import type { actors } from './db/schema/actors.ts';
import type { WsServerMessage } from '@babelr/shared';
import type { WebSocket } from 'ws';
import type { VoiceParticipant } from './plugins/ws.ts';

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
    broadcastToAllSubscribers: (message: WsServerMessage) => void;
    broadcastToActor: (actorId: string, message: WsServerMessage) => void;
    wsSubscribe: (ws: WebSocket, channelId: string) => void;
    wsUnsubscribe: (ws: WebSocket, channelId: string) => void;
    wsRemoveClient: (ws: WebSocket) => void;
    wsGetChannelSubs: (channelId: string) => Set<WebSocket>;
    wsRegisterActorConnection: (ws: WebSocket, actorId: string) => void;
    voiceJoin: (
      channelId: string,
      participant: VoiceParticipant,
    ) => VoiceParticipant[] | null;
    voiceLeave: (channelId: string, actorId: string) => boolean;
    voiceGetRoom: (channelId: string) => VoiceParticipant[];
    voiceBroadcastToRoom: (
      channelId: string,
      message: WsServerMessage,
      excludeActorId?: string,
    ) => void;
    voiceRelayToActor: (
      channelId: string,
      toActorId: string,
      message: WsServerMessage,
    ) => boolean;
  }

  interface FastifyRequest {
    actor?: typeof actors.$inferSelect;
  }
}
