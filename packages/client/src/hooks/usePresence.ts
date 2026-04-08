// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { PresenceStatus, WsServerMessage } from '@babelr/shared';
import { useWebSocket } from './useWebSocket';

export function usePresence(authenticated: boolean) {
  const [presenceStatus, setPresenceStatus] = useState<Map<string, PresenceStatus>>(new Map());

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'presence:update') {
      const { actorId, status } = msg.payload;
      setPresenceStatus((prev) => new Map(prev).set(actorId, status));
    }
  }, []);

  const { send, connected } = useWebSocket(authenticated, handleWsMessage);

  // Send heartbeat every 1 minute to keep presence as online
  useEffect(() => {
    if (!connected) return;

    const heartbeatInterval = setInterval(() => {
      send({ type: 'presence:heartbeat', payload: {} });
    }, 60 * 1000);

    return () => clearInterval(heartbeatInterval);
  }, [connected, send]);

  const getStatus = useCallback(
    (actorId: string): PresenceStatus => {
      return presenceStatus.get(actorId) ?? 'offline';
    },
    [presenceStatus],
  );

  return {
    presenceStatus,
    getStatus,
  };
}
