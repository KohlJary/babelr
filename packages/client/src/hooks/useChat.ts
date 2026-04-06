// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ActorProfile, ChannelView, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useChat(actor: ActorProfile) {
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const [messages, setMessages] = useState<MessageWithAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const channelRef = useRef<ChannelView | null>(null);

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'message:new') {
      setMessages((prev) => [...prev, msg.payload]);
    }
  }, []);

  const { connected, send } = useWebSocket(!!actor, handleWsMessage);

  // Load channels on mount
  useEffect(() => {
    api.getChannels().then((channels) => {
      if (channels.length > 0) {
        setChannel(channels[0]);
        channelRef.current = channels[0];
      }
    });
  }, []);

  // Subscribe to channel and load history when channel is set
  useEffect(() => {
    if (!channel) return;

    setLoading(true);
    setMessages([]);
    setCursor(undefined);

    api.getMessages(channel.id).then((res) => {
      // API returns newest-first, reverse for chronological display
      setMessages(res.messages.reverse());
      setHasMore(res.hasMore);
      if (res.cursor) setCursor(res.cursor);
      setLoading(false);
    });
  }, [channel]);

  // Subscribe via WS when channel and connection are ready
  useEffect(() => {
    if (!channel || !connected) return;

    send({ type: 'channel:subscribe', payload: { channelId: channel.id } });

    return () => {
      send({ type: 'channel:unsubscribe', payload: { channelId: channel.id } });
    };
  }, [channel, connected, send]);

  const loadMore = useCallback(async () => {
    if (!channel || !cursor || !hasMore) return;

    const res = await api.getMessages(channel.id, cursor);
    // Prepend older messages (reversed from newest-first to oldest-first)
    setMessages((prev) => [...res.messages.reverse(), ...prev]);
    setHasMore(res.hasMore);
    if (res.cursor) setCursor(res.cursor);
  }, [channel, cursor, hasMore]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!channel) return;
      await api.sendMessage(channel.id, content);
      // Message will arrive via WebSocket broadcast
    },
    [channel],
  );

  return {
    channel,
    messages,
    loading,
    hasMore,
    connected,
    sendMessage,
    loadMore,
  };
}
