// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentReplyStatusView, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
import * as api from '../api';

type StatusMap = Map<string, AgentReplyStatusView[]>;

/** Replace (or add) one agent's status in a message's list. */
function withStatus(list: AgentReplyStatusView[], status: AgentReplyStatusView) {
  return [...list.filter((s) => s.agent.id !== status.agent.id), status];
}

/**
 * Agents' reply status per message: seeded from the message history,
 * kept current by `agent-status:update` over the channel's WS. Same
 * shape as useReactions, and seeded the same way (a channel switch
 * resets; new messages only add).
 */
export function useAgentStatus(channelId: string | null, messages: MessageWithAuthor[]) {
  const [statuses, setStatuses] = useState<StatusMap>(() => new Map());
  const seededChannelRef = useRef<string | null>(null);

  useEffect(() => {
    const sameChannel = channelId === seededChannelRef.current;
    seededChannelRef.current = channelId;
    setStatuses((prev) => {
      const next: StatusMap = sameChannel ? new Map(prev) : new Map();
      for (const m of messages) {
        const s = m.message.agentStatus;
        if (s?.length && !next.has(m.message.id)) next.set(m.message.id, s);
      }
      return next;
    });
  }, [channelId, messages]);

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type !== 'agent-status:update') return;
    const { messageId, status } = msg.payload;
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(messageId, withStatus(next.get(messageId) ?? [], status));
      return next;
    });
  }, []);

  /** Ask the agent to try again. Throws with the server's reason. */
  const retry = useCallback(
    async (messageId: string, agentId: string) => {
      if (!channelId) return;
      const status = await api.retryAgentReply(channelId, messageId, agentId);
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(messageId, withStatus(next.get(messageId) ?? [], status));
        return next;
      });
    },
    [channelId],
  );

  return { agentStatuses: statuses, handleWsMessage, retryAgentReply: retry };
}
