// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ChannelView, CreateChannelInput } from '@babelr/shared';
import * as api from '../api';

export function useChannels(serverId: string | null) {
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<ChannelView | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverId) {
      setChannels([]);
      setSelectedChannel(null);
      return;
    }

    setLoading(true);
    api
      .getServerChannels(serverId)
      .then((ch) => {
        setChannels(ch);
        setSelectedChannel(ch.length > 0 ? ch[0] : null);
      })
      .finally(() => setLoading(false));
  }, [serverId]);

  const selectChannel = useCallback(
    (id: string) => {
      const ch = channels.find((c) => c.id === id);
      if (ch) setSelectedChannel(ch);
    },
    [channels],
  );

  const handleCreateChannel = useCallback(
    async (input: CreateChannelInput) => {
      if (!serverId) return;
      const channel = await api.createChannel(serverId, input);
      setChannels((prev) => [...prev, channel]);
      setSelectedChannel(channel);
    },
    [serverId],
  );

  return {
    channels,
    selectedChannel,
    loading,
    selectChannel,
    createChannel: handleCreateChannel,
  };
}
