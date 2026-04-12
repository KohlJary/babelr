// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback, useEffect, useRef } from 'react';
import type { WsServerMessage, MessageWithAuthor } from '@babelr/shared';
import * as api from '../api';

export function useReactions(channelId: string | null, actorId: string, messages: MessageWithAuthor[]) {
  const [messageReactions, setMessageReactions] = useState<Map<string, Record<string, string[]>>>(
    () => new Map(),
  );
  const seededChannelRef = useRef<string | null>(null);

  // Seed reactions from message history only when the channel changes
  // (initial load or channel switch). Subsequent message arrivals
  // must NOT re-seed — that would overwrite WS-delivered reaction
  // updates since message:new payloads don't carry reactions.
  useEffect(() => {
    if (channelId === seededChannelRef.current && messages.length > 0) {
      // Same channel, just new messages — merge any reactions from
      // the new messages without wiping existing WS-delivered state.
      setMessageReactions((prev) => {
        const next = new Map(prev);
        for (const m of messages) {
          if (m.message.reactions && Object.keys(m.message.reactions).length > 0 && !next.has(m.message.id)) {
            next.set(m.message.id, m.message.reactions);
          }
        }
        return next;
      });
      return;
    }
    // Channel changed — full reset from history.
    seededChannelRef.current = channelId;
    const next = new Map<string, Record<string, string[]>>();
    for (const m of messages) {
      if (m.message.reactions && Object.keys(m.message.reactions).length > 0) {
        next.set(m.message.id, m.message.reactions);
      }
    }
    setMessageReactions(next);
  }, [channelId, messages]);

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

      // Optimistic update
      setMessageReactions((prev) => {
        const next = new Map(prev);
        const reactions = { ...(next.get(messageId) ?? {}) };
        if (hasReacted) {
          reactions[emoji] = currentReactors.filter((id) => id !== actorId);
          if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
          reactions[emoji] = [...currentReactors, actorId];
        }
        if (Object.keys(reactions).length === 0) {
          next.delete(messageId);
        } else {
          next.set(messageId, reactions);
        }
        return next;
      });

      try {
        if (hasReacted) {
          await api.removeReaction(channelId, messageId, emoji);
        } else {
          await api.addReaction(channelId, messageId, emoji);
        }
      } catch (error) {
        console.error('Failed to toggle reaction:', error);
        // TODO: revert optimistic update on failure
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
