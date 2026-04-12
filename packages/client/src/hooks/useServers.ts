// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ServerView, CreateServerInput, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useServers() {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [selectedServer, setSelectedServer] = useState<ServerView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getServers()
      .then((s) => {
        setServers(s);
        if (s.length > 0) setSelectedServer(s[0]);
      })
      .finally(() => setLoading(false));
  }, []);

  // Live-refresh server list when metadata changes (local or federated).
  const handleWs = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'server:updated') {
      void api.getServers().then((refreshed) => {
        setServers(refreshed);
        setSelectedServer((prev) => {
          if (!prev) return prev;
          return refreshed.find((s) => s.id === prev.id) ?? prev;
        });
      });
    }
  }, []);
  useWebSocket(true, handleWs);

  const selectServer = useCallback(
    (id: string) => {
      const server = servers.find((s) => s.id === id);
      if (server) setSelectedServer(server);
    },
    [servers],
  );

  const handleCreateServer = useCallback(async (input: CreateServerInput) => {
    const server = await api.createServer(input);
    setServers((prev) => [...prev, server]);
    setSelectedServer(server);
    return server;
  }, []);

  const handleJoinServer = useCallback(async (serverId: string) => {
    await api.joinServer(serverId);
    const refreshed = await api.getServers();
    setServers(refreshed);
    const joined = refreshed.find((s) => s.id === serverId);
    if (joined) setSelectedServer(joined);
  }, []);

  const updateServer = useCallback((updated: ServerView) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setSelectedServer((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  const handleLeaveServer = useCallback(
    async (serverId: string) => {
      await api.leaveServer(serverId);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      if (selectedServer?.id === serverId) {
        setSelectedServer(servers.find((s) => s.id !== serverId) ?? null);
      }
    },
    [selectedServer, servers],
  );

  const refreshServers = useCallback(async () => {
    const refreshed = await api.getServers();
    setServers(refreshed);
  }, []);

  return {
    servers,
    selectedServer,
    loading,
    selectServer,
    createServer: handleCreateServer,
    joinServer: handleJoinServer,
    leaveServer: handleLeaveServer,
    updateServer,
    refreshServers,
  };
}
