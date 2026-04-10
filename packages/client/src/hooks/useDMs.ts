// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { DMConversation, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useDMs() {
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [selectedDM, setSelectedDM] = useState<DMConversation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getDMs()
      .then(setConversations)
      .finally(() => setLoading(false));
  }, []);

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'conversation:new') {
      const conv = msg.payload.conversation;
      setConversations((prev) => {
        if (prev.find((c) => c.id === conv.id)) return prev;
        return [conv, ...prev];
      });
    } else if (msg.type === 'dm:read') {
      const { dmId, actorUri, lastReadAt } = msg.payload;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === dmId
            ? { ...c, readBy: { ...(c.readBy ?? {}), [actorUri]: lastReadAt } }
            : c,
        ),
      );
      setSelectedDM((prev) =>
        prev && prev.id === dmId
          ? { ...prev, readBy: { ...(prev.readBy ?? {}), [actorUri]: lastReadAt } }
          : prev,
      );
    }
  }, []);

  useWebSocket(true, handleWsMessage);

  const selectDM = useCallback(
    (id: string) => {
      const dm = conversations.find((c) => c.id === id);
      if (dm) setSelectedDM(dm);
    },
    [conversations],
  );

  const handleStartDM = useCallback(async (participantId: string) => {
    const dm = await api.startDM(participantId);
    setConversations((prev) => {
      const exists = prev.find((c) => c.id === dm.id);
      return exists ? prev : [dm, ...prev];
    });
    setSelectedDM(dm);
    return dm;
  }, []);

  return {
    conversations,
    selectedDM,
    loading,
    selectDM,
    startDM: handleStartDM,
  };
}
