// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback, useRef } from 'react';
import type { WsServerMessage } from '@babelr/shared';
import * as api from '../api';

export function useReactions(channelId: string | null) {
  const [messageReactions, setMessageReactions] = useState<Map<string, Record<string, string[]>>>(new Map());
  const messagesRef = useRef(messageReactions);
  messagesRef.current = messageReactions;

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'reaction:add') {
      const { messageId, emoji, actor } = msg.payload;
      setMessageReactions((prev) => {
        const next = new Map(prev);
        const msgReactions = next.get(messageId) ?? {};
        const emojiReactors = msgReactions[emoji] ?? [];
        if (!emojiReactors.includes(actor.id)) {
          msgReactions[emoji] = [...emojiReactors, actor.id];
        }
        next.set(messageId, msgReactions);
        return next;
      });
    } else if (msg.type === 'reaction:remove') {
      const { messageId, emoji, actorId } = msg.payload;
      setMessageReactions((prev) => {
        const next = new Map(prev);
        const msgReactions = next.get(messageId);
        if (msgReactions && msgReactions[emoji]) {
          const filtered = msgReactions[emoji].filter((id) => id !== actorId);
          if (filtered.length === 0) {
            delete msgReactions[emoji];
          } else {
            msgReactions[emoji] = filtered;
          }
          if (Object.keys(msgReactions).length === 0) {
            next.delete(messageId);
          } else {
            next.set(messageId, msgReactions);
          }
        }
        return next;
      });
    }
  }, []);

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!channelId) return;

      const msgReactions = messageReactions.get(messageId);
      const currentReactors = msgReactions?.[emoji] ?? [];

      try {
        if (currentReactors.length > 0) {
          // Optimistically remove first
          await api.removeReaction(channelId, messageId, emoji);
        } else {
          // Or add
          await api.addReaction(channelId, messageId, emoji);
        }
      } catch (error) {
        console.error('Failed to toggle reaction:', error);
      }
    },
    [channelId, messageReactions],
  );

  return {
    messageReactions,
    handleWsMessage,
    toggleReaction,
  };
}
