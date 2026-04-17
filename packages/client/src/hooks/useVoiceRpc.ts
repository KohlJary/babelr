// SPDX-License-Identifier: Hippocratic-3.0
import { useRef, useCallback } from 'react';
import type { WsServerMessage, WsClientMessage } from '@babelr/shared';

export interface PendingRequest {
  resolve: (msg: WsServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function useVoiceRpc() {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const requestSeqRef = useRef(0);

  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const newRequestId = useCallback(() => {
    requestSeqRef.current += 1;
    return `r${requestSeqRef.current}`;
  }, []);

  /**
   * Send a WS request and resolve when the matching response (or
   * voice:request-error with the same requestId) arrives. The handlers
   * for transport-created / transport-connected / produced / consumed /
   * consumer-resumed / producer-closed-ack all dispatch through this map.
   */
  const rpc = useCallback(
    <T extends WsServerMessage>(
      build: (requestId: string) => WsClientMessage,
    ): Promise<T> => {
      const requestId = newRequestId();
      const msg = build(requestId);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error(`voice rpc timeout: ${msg.type}`));
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(requestId, {
          resolve: (m) => resolve(m as T),
          reject,
          timer,
        });
        sendWs(msg);
      });
    },
    [newRequestId, sendWs],
  );

  return { wsRef, sendWs, rpc, pendingRef };
}
