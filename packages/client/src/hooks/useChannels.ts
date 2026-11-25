// SPDX-License-Identifier: MIT
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

    let cancelled = false;
    setLoading(true);
    api
      .getServerChannels(serverId)
      .then((ch) => {
        if (cancelled) return;
        setChannels(ch);
        setSelectedChannel(ch.length > 0 ? ch[0] : null);
      })
      .catch((err) => {
        // A server we can't read (403) shows no channels rather than an
        // uncaught rejection; switching servers retries.
        if (cancelled) return;
        console.warn('[channels] could not load channels', err);
        setChannels([]);
        setSelectedChannel(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  const updateChannel = useCallback((updated: ChannelView) => {
    setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setSelectedChannel((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  return {
    channels,
    selectedChannel,
    loading,
    selectChannel,
    createChannel: handleCreateChannel,
    updateChannel,
  };
}
