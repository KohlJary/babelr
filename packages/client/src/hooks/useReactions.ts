// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback, useEffect } from 'react';
import type { WsServerMessage, MessageWithAuthor } from '@babelr/shared';
import * as api from '../api';

export function useReactions(channelId: string | null, actorId: string, messages: MessageWithAuthor[]) {
  const [messageReactions, setMessageReactions] = useState<Map<string, Record<string, string[]>>>(
    () => new Map(),
  );

  // Seed reactions from message history
  useEffect(() => {
    const next = new Map<string, Record<string, string[]>>();
    for (const m of messages) {
      if (m.message.reactions && Object.keys(m.message.reactions).length > 0) {
        next.set(m.message.id, m.message.reactions);
      }
    }
    setMessageReactions(next);
  }, [messages]);

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'reaction:add') {
      const { messageId, emoji, actor } = msg.payload;
      setMessageReactions((prev) => {
        const next = new Map(prev);
        const msgReactions = { ...(next.get(messageId) ?? {}) };
        const emojiReactors = msgReactions[emoji] ?? [];
        if (!emojiReactors.includes(actor.id)) {
          msgReactions[emoji] = [...emojiReactors, actor.id];
        }
        next.set(messageId, msgReactions);
        return next;
      });
    } else if (msg.type === 'reaction:remove') {
      const { messageId, emoji, actorId: removedId } = msg.payload;
      setMessageReactions((prev) => {
        const next = new Map(prev);
        const msgReactions = { ...(next.get(messageId) ?? {}) };
        if (msgReactions[emoji]) {
          const filtered = msgReactions[emoji].filter((id) => id !== removedId);
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
      const hasReacted = currentReactors.includes(actorId);

      try {
        if (hasReacted) {
          await api.removeReaction(channelId, messageId, emoji);
        } else {
          await api.addReaction(channelId, messageId, emoji);
        }
      } catch (error) {
        console.error('Failed to toggle reaction:', error);
      }
    },
    [channelId, actorId, messageReactions],
  );

  return {
    messageReactions,
    handleWsMessage,
    toggleReaction,
  };
}
