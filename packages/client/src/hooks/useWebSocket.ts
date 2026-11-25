// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, useCallback } from 'react';
import type { WsServerMessage, WsClientMessage } from '@babelr/shared';
import { getWsConnection } from './wsConnection';

/**
 * Subscribe to the tab's shared /ws connection (see wsConnection.ts).
 * `enabled` holds the connection open for this caller; `onMessage`
 * receives every server message while the hook is mounted and enabled.
 */
export function useWebSocket(enabled: boolean, onMessage: (msg: WsServerMessage) => void) {
  const conn = getWsConnection();
  const [connected, setConnected] = useState(() => enabled && conn.isConnected());
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const send = useCallback((msg: WsClientMessage) => conn.send(msg), [conn]);

  useEffect(() => {
    if (!enabled) return;
    const offMessage = conn.onMessage((msg) => onMessageRef.current(msg));
    const offConnected = conn.onConnected(setConnected);
    const release = conn.acquire();
    setConnected(conn.isConnected());
    return () => {
      offMessage();
      offConnected();
      release();
      setConnected(false);
    };
  }, [enabled, conn]);

  return { connected, send };
}
