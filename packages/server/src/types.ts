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
    wsUnsubscribeActor: (actorId: string, channelId: string) => void;
    wsRemoveClient: (ws: WebSocket) => void;
    wsGetChannelSubs: (channelId: string) => Set<WebSocket>;
    wsRegisterActorConnection: (ws: WebSocket, actorId: string) => void;
    voiceJoin: (channelId: string, participant: VoiceParticipant) => VoiceParticipant[] | null;
    voiceLeave: (channelId: string, actorId: string) => { closedProducerIds: string[] } | null;
    voiceGetRoom: (channelId: string) => VoiceParticipant[];
    voiceBroadcastToRoom: (
      channelId: string,
      message: WsServerMessage,
      excludeActorId?: string,
    ) => void;
  }

  interface FastifyRequest {
    actor?: typeof actors.$inferSelect;
    /** Scopes of the agent token that authenticated this request.
     *  Undefined for cookie sessions. */
    agentScopes?: string[];
    /** Set for every bearer-token request (allowed or denied) so the
     *  onResponse hook can write the agent audit row. */
    agentAuth?: {
      tokenId: string | null;
      /** Null when the token matches no agent. */
      actorId: string | null;
      sponsorId: string | null;
      scope: string | null;
      route: string;
      action: string;
      denial?: string;
      /** sha256(raw token) prefix, for tokens that match no agent. */
      fingerprint: string;
    };
    /** Exact request body, set only on routes that call
     *  captureRawBody (signature-verified federation routes). */
    rawBody?: string;
  }
}
