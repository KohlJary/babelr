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
