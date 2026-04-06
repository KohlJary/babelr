// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { DMConversation } from '@babelr/shared';
import * as api from '../api';

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
