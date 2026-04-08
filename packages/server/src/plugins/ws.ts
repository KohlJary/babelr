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

function removeClient(ws: WebSocket) {
  const channels = clientChannels.get(ws);
  if (channels) {
    for (const channelId of channels) {
      channelSubscriptions.get(channelId)?.delete(ws);
    }
  }
  clientChannels.delete(ws);
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
  fastify.decorate('wsRemoveClient', removeClient);
}

export default fp(wsPlugin, {
  name: 'ws',
  dependencies: ['db', 'auth'],
});
