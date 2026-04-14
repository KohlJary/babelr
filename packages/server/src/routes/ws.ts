// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import '../types.ts';
import type { WsClientMessage, WsServerMessage } from '@babelr/shared';
import { PERMISSIONS } from '@babelr/shared';
import { eq } from 'drizzle-orm';
import { objects } from '../db/schema/objects.ts';
import { hasPermission } from '../permissions.ts';
import {
  joinRoom as sfuJoinRoom,
  createTransport as sfuCreateTransport,
  connectTransport as sfuConnectTransport,
  produce as sfuProduce,
  consume as sfuConsume,
  resumeConsumer as sfuResumeConsumer,
  closeProducer as sfuCloseProducer,
} from '../voice/sfu.ts';
import type {
  SfuRtpCapabilities,
  SfuTransportParams,
  SfuProducerInfo,
} from '@babelr/shared';
import type {
  DtlsParameters,
  RtpCapabilities,
  RtpParameters,
} from 'mediasoup/types';

function sendRequestError(
  socket: WebSocket,
  requestId: string,
  message: string,
) {
  const err: WsServerMessage = {
    type: 'voice:request-error',
    payload: { requestId, message },
  };
  socket.send(JSON.stringify(err));
}

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

    socket.on('message', async (raw: Buffer) => {
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
            // CONNECT_VOICE permission check
            const db = fastify.db;
            const [voiceCh] = await db
              .select({ belongsTo: objects.belongsTo })
              .from(objects)
              .where(eq(objects.id, channelId))
              .limit(1);
            if (voiceCh?.belongsTo) {
              const allowed = await hasPermission(
                db,
                voiceCh.belongsTo,
                actor.id,
                PERMISSIONS.CONNECT_VOICE,
              );
              if (!allowed) {
                const errMsg: WsServerMessage = {
                  type: 'error',
                  payload: { message: 'Insufficient permissions to join voice' },
                };
                socket.send(JSON.stringify(errMsg));
                break;
              }
            }
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
            // SFU: create router on first join, return router caps + existing producers
            try {
              const { rtpCapabilities, peers } = await sfuJoinRoom(channelId, actor.id);
              const joinedSfuMsg: WsServerMessage = {
                type: 'voice:joined',
                payload: {
                  channelId,
                  routerRtpCapabilities: rtpCapabilities as SfuRtpCapabilities,
                  peers: peers.map((p) => ({
                    actorId: p.actorId,
                    producers: p.producers.map<SfuProducerInfo>((pr) => ({
                      peerActorId: p.actorId,
                      producerId: pr.producerId,
                      kind: pr.kind,
                      slot: pr.slot,
                    })),
                  })),
                },
              };
              socket.send(JSON.stringify(joinedSfuMsg));
            } catch (err) {
              fastify.log.error({ err, channelId }, 'sfu join failed');
            }
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
            const result = fastify.voiceLeave(channelId, actor.id);
            if (result) {
              const leftMsg: WsServerMessage = {
                type: 'voice:participant-left',
                payload: { channelId, actorId: actor.id },
              };
              fastify.voiceBroadcastToRoom(channelId, leftMsg);
              for (const producerId of result.closedProducerIds) {
                const closed: WsServerMessage = {
                  type: 'voice:producer-closed',
                  payload: { channelId, peerActorId: actor.id, producerId },
                };
                fastify.voiceBroadcastToRoom(channelId, closed);
              }
            }
            break;
          }
          case 'voice:create-transport': {
            const { requestId, channelId, direction } = msg.payload;
            try {
              const params = await sfuCreateTransport(channelId, actor.id, direction);
              const reply: WsServerMessage = {
                type: 'voice:transport-created',
                payload: {
                  requestId,
                  direction,
                  params: params as unknown as SfuTransportParams,
                },
              };
              socket.send(JSON.stringify(reply));
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
            break;
          }
          case 'voice:connect-transport': {
            const { requestId, channelId, transportId, dtlsParameters } = msg.payload;
            try {
              await sfuConnectTransport(
                channelId,
                actor.id,
                transportId,
                dtlsParameters as DtlsParameters,
              );
              const reply: WsServerMessage = {
                type: 'voice:transport-connected',
                payload: { requestId },
              };
              socket.send(JSON.stringify(reply));
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
            break;
          }
          case 'voice:produce': {
            const { requestId, channelId, transportId, kind, rtpParameters, slot } =
              msg.payload;
            try {
              const { producerId } = await sfuProduce(
                channelId,
                actor.id,
                transportId,
                kind,
                rtpParameters as RtpParameters,
                slot,
              );
              const reply: WsServerMessage = {
                type: 'voice:produced',
                payload: { requestId, producerId },
              };
              socket.send(JSON.stringify(reply));
              const newProducer: WsServerMessage = {
                type: 'voice:new-producer',
                payload: {
                  channelId,
                  producer: {
                    peerActorId: actor.id,
                    producerId,
                    kind,
                    slot,
                  },
                },
              };
              fastify.voiceBroadcastToRoom(channelId, newProducer, actor.id);
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
            break;
          }
          case 'voice:consume': {
            const {
              requestId,
              channelId,
              transportId,
              producerId,
              rtpCapabilities,
            } = msg.payload;
            try {
              const result = await sfuConsume(
                channelId,
                actor.id,
                transportId,
                producerId,
                rtpCapabilities as RtpCapabilities,
              );
              const reply: WsServerMessage = {
                type: 'voice:consumed',
                payload: {
                  requestId,
                  consumer: {
                    id: result.consumerId,
                    producerId,
                    kind: result.kind,
                    rtpParameters: result.rtpParameters,
                    peerActorId: result.peerActorId,
                    slot: result.slot,
                  },
                },
              };
              socket.send(JSON.stringify(reply));
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
            break;
          }
          case 'voice:resume-consumer': {
            const { requestId, channelId, consumerId } = msg.payload;
            try {
              await sfuResumeConsumer(channelId, actor.id, consumerId);
              const reply: WsServerMessage = {
                type: 'voice:consumer-resumed',
                payload: { requestId },
              };
              socket.send(JSON.stringify(reply));
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
            break;
          }
          case 'voice:close-producer': {
            const { requestId, channelId, producerId } = msg.payload;
            try {
              const closed = sfuCloseProducer(channelId, actor.id, producerId);
              const reply: WsServerMessage = {
                type: 'voice:producer-closed-ack',
                payload: { requestId },
              };
              socket.send(JSON.stringify(reply));
              if (closed) {
                const broadcast: WsServerMessage = {
                  type: 'voice:producer-closed',
                  payload: {
                    channelId,
                    peerActorId: actor.id,
                    producerId: closed.producerId,
                  },
                };
                fastify.voiceBroadcastToRoom(channelId, broadcast, actor.id);
              }
            } catch (err) {
              sendRequestError(socket, requestId, (err as Error).message);
            }
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
