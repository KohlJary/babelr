// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ActorProfile, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useChat(actor: ActorProfile, channelId: string | null, isDM = false) {
  const [messages, setMessages] = useState<MessageWithAuthor[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'message:new') {
      setMessages((prev) => [...prev, msg.payload]);
    }
  }, []);

  const { connected, send } = useWebSocket(!!actor, handleWsMessage);

  // Load history when channel changes
  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      return;
    }

    setLoading(true);
    setMessages([]);
    setCursor(undefined);

    api.getMessages(channelId, undefined, isDM).then((res) => {
      setMessages(res.messages.reverse());
      setHasMore(res.hasMore);
      if (res.cursor) setCursor(res.cursor);
      setLoading(false);
    });
  }, [channelId, isDM]);

  // Subscribe via WS when channel and connection are ready
  useEffect(() => {
    if (!channelId || !connected) return;

    send({ type: 'channel:subscribe', payload: { channelId } });

    return () => {
      send({ type: 'channel:unsubscribe', payload: { channelId } });
    };
  }, [channelId, connected, send]);

  const loadMore = useCallback(async () => {
    if (!channelId || !cursor || !hasMore) return;

    const res = await api.getMessages(channelId, cursor, isDM);
    setMessages((prev) => [...res.messages.reverse(), ...prev]);
    setHasMore(res.hasMore);
    if (res.cursor) setCursor(res.cursor);
  }, [channelId, cursor, hasMore, isDM]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!channelId) return;
      await api.sendMessage(channelId, content, isDM);
    },
    [channelId, isDM],
  );

  return {
    messages,
    loading,
    hasMore,
    connected,
    sendMessage,
    loadMore,
  };
}
