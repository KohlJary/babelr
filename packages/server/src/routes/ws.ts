// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import '../types.ts';
import type { WsClientMessage, WsServerMessage } from '@babelr/shared';

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    if (!request.actor) {
      const error: WsServerMessage = {
        type: 'error',
        payload: { message: 'Not authenticated' },
      };
      socket.send(JSON.stringify(error));
      socket.close(4001, 'Not authenticated');
      return;
    }

    const actor = request.actor;

    // Register the connection for presence tracking
    fastify.wsRegisterActorConnection(socket, actor.id);

    // Send connected confirmation
    const connected: WsServerMessage = {
      type: 'connected',
      payload: { actorId: actor.id },
    };
    socket.send(JSON.stringify(connected));

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsClientMessage;

        switch (msg.type) {
          case 'channel:subscribe':
            fastify.wsSubscribe(socket, msg.payload.channelId);
            break;
          case 'channel:unsubscribe':
            fastify.wsUnsubscribe(socket, msg.payload.channelId);
            break;
          case 'typing:start': {
            // Broadcast to channel subscribers, excluding sender
            const typingMsg: WsServerMessage = {
              type: 'typing:start',
              payload: {
                channelId: msg.payload.channelId,
                actor: {
                  id: actor.id,
                  preferredUsername: actor.preferredUsername,
                  displayName: actor.displayName,
                },
              },
            };
            const data = JSON.stringify(typingMsg);
            const subs = fastify.wsGetChannelSubs(msg.payload.channelId);
            for (const ws of subs) {
              if (ws !== socket && ws.readyState === ws.OPEN) {
                ws.send(data);
              }
            }
            break;
          }
          case 'presence:heartbeat': {
            // Reset heartbeat timeout by re-registering
            fastify.wsRegisterActorConnection(socket, actor.id);
            break;
          }
          case 'voice:join': {
            const channelId = msg.payload.channelId;
            const actorProps = (actor.properties as Record<string, unknown> | null) ?? null;
            const participant = {
              actorId: actor.id,
              preferredUsername: actor.preferredUsername,
              displayName: actor.displayName,
              avatarUrl: (actorProps?.avatarUrl as string | null) ?? null,
              uri: actor.uri,
              ws: socket,
            };
            const existing = fastify.voiceJoin(channelId, participant);
            if (existing === null) {
              const fullMsg: WsServerMessage = {
                type: 'voice:full',
                payload: { channelId, max: 8 },
              };
              socket.send(JSON.stringify(fullMsg));
              break;
            }
            // Send current room state to the new joiner
            const stateMsg: WsServerMessage = {
              type: 'voice:room-state',
              payload: {
                channelId,
                participants: existing.map((p) => ({
                  id: p.actorId,
                  preferredUsername: p.preferredUsername,
                  displayName: p.displayName,
                  avatarUrl: p.avatarUrl,
                  uri: p.uri,
                })),
              },
            };
            socket.send(JSON.stringify(stateMsg));
            // Broadcast participant-joined to existing peers
            const joinedMsg: WsServerMessage = {
              type: 'voice:participant-joined',
              payload: {
                channelId,
                participant: {
                  id: actor.id,
                  preferredUsername: actor.preferredUsername,
                  displayName: actor.displayName,
                  avatarUrl: participant.avatarUrl,
                  uri: actor.uri,
                },
              },
            };
            fastify.voiceBroadcastToRoom(channelId, joinedMsg, actor.id);
            break;
          }
          case 'voice:leave': {
            const channelId = msg.payload.channelId;
            if (fastify.voiceLeave(channelId, actor.id)) {
              const leftMsg: WsServerMessage = {
                type: 'voice:participant-left',
                payload: { channelId, actorId: actor.id },
              };
              fastify.voiceBroadcastToRoom(channelId, leftMsg);
            }
            break;
          }
          case 'voice:offer': {
            const relay: WsServerMessage = {
              type: 'voice:offer',
              payload: {
                channelId: msg.payload.channelId,
                fromActorId: actor.id,
                toActorId: msg.payload.toActorId,
                sdp: msg.payload.sdp,
              },
            };
            fastify.voiceRelayToActor(msg.payload.channelId, msg.payload.toActorId, relay);
            break;
          }
          case 'voice:answer': {
            const relay: WsServerMessage = {
              type: 'voice:answer',
              payload: {
                channelId: msg.payload.channelId,
                fromActorId: actor.id,
                toActorId: msg.payload.toActorId,
                sdp: msg.payload.sdp,
              },
            };
            fastify.voiceRelayToActor(msg.payload.channelId, msg.payload.toActorId, relay);
            break;
          }
          case 'voice:ice': {
            const relay: WsServerMessage = {
              type: 'voice:ice',
              payload: {
                channelId: msg.payload.channelId,
                fromActorId: actor.id,
                toActorId: msg.payload.toActorId,
                candidate: msg.payload.candidate,
              },
            };
            fastify.voiceRelayToActor(msg.payload.channelId, msg.payload.toActorId, relay);
            break;
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      fastify.wsRemoveClient(socket);
    });
  });
}
