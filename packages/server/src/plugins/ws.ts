// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import '../types.ts';
import type { WsServerMessage } from '@babelr/shared';

// channelId -> set of subscribed sockets
const channelSubscriptions = new Map<string, Set<WebSocket>>();
// socket -> set of channels it's subscribed to
const clientChannels = new Map<WebSocket, Set<string>>();
// actorId -> set of active WS connections
const actorConnections = new Map<string, Set<WebSocket>>();

// Voice room state: channelId -> (actorId -> { ws, actor })
// Tracks who is currently connected to each voice channel. Audio flows
// peer-to-peer via WebRTC; the server only relays SDP/ICE metadata.
export interface VoiceParticipant {
  actorId: string;
  preferredUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  uri: string;
  ws: WebSocket;
}
const voiceRooms = new Map<string, Map<string, VoiceParticipant>>();
// socket -> set of voice channels it's joined (for cleanup on disconnect)
const socketVoiceRooms = new Map<WebSocket, Set<string>>();

export const VOICE_ROOM_MAX = 8;
// socket -> { actorId, heartbeatTimeout }
interface SocketMeta {
  actorId: string;
  heartbeatTimeout: NodeJS.Timeout;
}
const socketMeta = new Map<WebSocket, SocketMeta>();

function subscribe(ws: WebSocket, channelId: string) {
  let subs = channelSubscriptions.get(channelId);
  if (!subs) {
    subs = new Set();
    channelSubscriptions.set(channelId, subs);
  }
  subs.add(ws);

  let channels = clientChannels.get(ws);
  if (!channels) {
    channels = new Set();
    clientChannels.set(ws, channels);
  }
  channels.add(channelId);
}

function unsubscribe(ws: WebSocket, channelId: string) {
  channelSubscriptions.get(channelId)?.delete(ws);
  clientChannels.get(ws)?.delete(channelId);
}

function removeClient(ws: WebSocket, fastify?: FastifyInstance) {
  const channels = clientChannels.get(ws);
  if (channels) {
    for (const channelId of channels) {
      channelSubscriptions.get(channelId)?.delete(ws);
    }
  }
  clientChannels.delete(ws);

  // Clean up voice room membership
  const joinedVoice = socketVoiceRooms.get(ws);
  if (joinedVoice) {
    for (const channelId of joinedVoice) {
      const room = voiceRooms.get(channelId);
      if (!room) continue;
      // Find and remove the entry whose ws matches
      for (const [actorId, participant] of room.entries()) {
        if (participant.ws === ws) {
          room.delete(actorId);
          // Broadcast participant-left to remaining peers
          if (fastify) {
            const leftMsg = {
              type: 'voice:participant-left' as const,
              payload: { channelId, actorId },
            };
            const data = JSON.stringify(leftMsg);
            for (const p of room.values()) {
              if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
            }
          }
          break;
        }
      }
      if (room.size === 0) voiceRooms.delete(channelId);
    }
    socketVoiceRooms.delete(ws);
  }

  // Clean up presence
  const meta = socketMeta.get(ws);
  if (meta) {
    clearTimeout(meta.heartbeatTimeout);
    const actorConnections_ = actorConnections.get(meta.actorId);
    if (actorConnections_) {
      actorConnections_.delete(ws);
      // If no more connections for this actor, broadcast offline
      if (actorConnections_.size === 0) {
        actorConnections.delete(meta.actorId);
        if (fastify) {
          const offlineMsg: WsServerMessage = {
            type: 'presence:update',
            payload: { actorId: meta.actorId, status: 'offline' },
          };
          const data = JSON.stringify(offlineMsg);
          for (const [, subs] of channelSubscriptions) {
            for (const ws_ of subs) {
              if (ws_.readyState === ws_.OPEN) {
                ws_.send(data);
              }
            }
          }
        }
      }
    }
    socketMeta.delete(ws);
  }
}

function broadcastToAllChannels(fastify: FastifyInstance, message: WsServerMessage) {
  const data = JSON.stringify(message);
  for (const subs of channelSubscriptions.values()) {
    for (const ws of subs) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }
}

/**
 * Add a participant to a voice room. Returns the existing participants so
 * the new joiner can initiate WebRTC offers to each of them.
 * Rejects with null if the room is full.
 */
function voiceJoin(
  channelId: string,
  participant: VoiceParticipant,
): VoiceParticipant[] | null {
  let room = voiceRooms.get(channelId);
  if (!room) {
    room = new Map();
    voiceRooms.set(channelId, room);
  }
  if (room.size >= VOICE_ROOM_MAX) return null;
  // If same actor is already in the room (e.g., reconnecting), replace them
  const existing = room.get(participant.actorId);
  if (existing) {
    // Best-effort cleanup of their previous socket tracking
    socketVoiceRooms.get(existing.ws)?.delete(channelId);
  }
  room.set(participant.actorId, participant);

  let perSocket = socketVoiceRooms.get(participant.ws);
  if (!perSocket) {
    perSocket = new Set();
    socketVoiceRooms.set(participant.ws, perSocket);
  }
  perSocket.add(channelId);

  return Array.from(room.values()).filter((p) => p.actorId !== participant.actorId);
}

function voiceLeave(channelId: string, actorId: string): boolean {
  const room = voiceRooms.get(channelId);
  if (!room) return false;
  const p = room.get(actorId);
  if (!p) return false;
  room.delete(actorId);
  socketVoiceRooms.get(p.ws)?.delete(channelId);
  if (room.size === 0) voiceRooms.delete(channelId);
  return true;
}

function voiceGetRoom(channelId: string): VoiceParticipant[] {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  return Array.from(room.values());
}

function voiceBroadcastToRoom(
  channelId: string,
  message: WsServerMessage,
  excludeActorId?: string,
) {
  const room = voiceRooms.get(channelId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const p of room.values()) {
    if (excludeActorId && p.actorId === excludeActorId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function voiceRelayToActor(
  channelId: string,
  toActorId: string,
  message: WsServerMessage,
): boolean {
  const room = voiceRooms.get(channelId);
  if (!room) return false;
  const target = room.get(toActorId);
  if (!target) return false;
  if (target.ws.readyState !== target.ws.OPEN) return false;
  target.ws.send(JSON.stringify(message));
  return true;
}

function registerActorConnection(ws: WebSocket, actorId: string, fastify: FastifyInstance) {
  let connections = actorConnections.get(actorId);
  if (!connections) {
    connections = new Set();
    actorConnections.set(actorId, connections);
    // New connection for this actor - broadcast online
    const onlineMsg: WsServerMessage = {
      type: 'presence:update',
      payload: { actorId, status: 'online' },
    };
    broadcastToAllChannels(fastify, onlineMsg);
  }
  connections.add(ws);

  // Set up heartbeat timeout (5min inactivity = away)
  const heartbeatTimeout = setTimeout(() => {
    if (connections && connections.has(ws)) {
      const awayMsg: WsServerMessage = {
        type: 'presence:update',
        payload: { actorId, status: 'away' },
      };
      broadcastToAllChannels(fastify, awayMsg);
    }
  }, 5 * 60 * 1000);

  socketMeta.set(ws, { actorId, heartbeatTimeout });
}

async function wsPlugin(fastify: FastifyInstance) {
  await fastify.register(websocket);

  fastify.decorate('broadcastToChannel', (channelId: string, message: WsServerMessage) => {
    const subs = channelSubscriptions.get(channelId);
    if (!subs) return;

    const data = JSON.stringify(message);
    for (const ws of subs) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  });

  // Broadcast to all WS clients subscribed to any channel. Used for
  // server-scoped events (wiki changes, file changes) that should
  // reach any online member regardless of which channel they're in.
  fastify.decorate('broadcastToAllSubscribers', (message: WsServerMessage) => {
    const data = JSON.stringify(message);
    const seen = new Set<WebSocket>();
    for (const subs of channelSubscriptions.values()) {
      for (const ws of subs) {
        if (!seen.has(ws) && ws.readyState === ws.OPEN) {
          ws.send(data);
          seen.add(ws);
        }
      }
    }
  });

  fastify.decorate('broadcastToActor', (actorId: string, message: WsServerMessage) => {
    const connections = actorConnections.get(actorId);
    if (!connections) return;

    const data = JSON.stringify(message);
    for (const ws of connections) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  });

  fastify.decorate('wsGetChannelSubs', (channelId: string): Set<WebSocket> => {
    return channelSubscriptions.get(channelId) ?? new Set();
  });

  // Export subscribe/unsubscribe for the WS route
  fastify.decorate('wsSubscribe', subscribe);
  fastify.decorate('wsUnsubscribe', unsubscribe);
  fastify.decorate('wsRemoveClient', (ws: WebSocket) => removeClient(ws, fastify));
  fastify.decorate('wsRegisterActorConnection', (ws: WebSocket, actorId: string) => {
    registerActorConnection(ws, actorId, fastify);
  });

  fastify.decorate('voiceJoin', voiceJoin);
  fastify.decorate('voiceLeave', voiceLeave);
  fastify.decorate('voiceGetRoom', voiceGetRoom);
  fastify.decorate('voiceBroadcastToRoom', voiceBroadcastToRoom);
  fastify.decorate('voiceRelayToActor', voiceRelayToActor);
}

export default fp(wsPlugin, {
  name: 'ws',
  dependencies: ['db', 'auth'],
});
