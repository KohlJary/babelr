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
}

export default fp(wsPlugin, {
  name: 'ws',
  dependencies: ['db', 'auth'],
});
