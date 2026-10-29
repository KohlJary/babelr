// SPDX-License-Identifier: MIT
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { DMConversation, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useDMs() {
  const [list, setList] = useState<DMConversation[]>([]);
  // Message requests waiting for my answer, listed first.
  const [requests, setRequests] = useState<DMConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getDMs().then(setList),
      api
        .getDMRequests()
        .then(setRequests)
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const conversations = useMemo(() => [...requests, ...list], [requests, list]);
  const selectedDM = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const drop = useCallback((dmId: string) => {
    setList((prev) => prev.filter((c) => c.id !== dmId));
    setRequests((prev) => prev.filter((c) => c.id !== dmId));
    setSelectedId((prev) => (prev === dmId ? null : prev));
  }, []);

  const handleWsMessage = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === 'conversation:new') {
        const conv = msg.payload.conversation;
        setList((prev) => (prev.find((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      } else if (msg.type === 'dm:request') {
        const conv = msg.payload.conversation;
        setRequests((prev) => (prev.find((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      } else if (msg.type === 'dm:removed') {
        drop(msg.payload.dmId);
      } else if (msg.type === 'dm:left') {
        const { dmId, actor } = msg.payload;
        const mark = (c: DMConversation) =>
          c.id === dmId
            ? {
                ...c,
                participants: c.participants.filter((p) => p.id !== actor.id),
                left: [...(c.left ?? []).filter((p) => p.id !== actor.id), actor],
              }
            : c;
        setList((prev) => prev.map(mark));
      } else if (msg.type === 'dm:read') {
        const { dmId, actorUri, lastReadAt } = msg.payload;
        setList((prev) =>
          prev.map((c) =>
            c.id === dmId ? { ...c, readBy: { ...(c.readBy ?? {}), [actorUri]: lastReadAt } } : c,
          ),
        );
      }
    },
    [drop],
  );

  useWebSocket(true, handleWsMessage);

  const selectDM = useCallback((id: string) => setSelectedId(id), []);

  const handleStartDM = useCallback(async (participantId: string) => {
    const dm = await api.startDM(participantId);
    setRequests((prev) => prev.filter((c) => c.id !== dm.id));
    setList((prev) => [dm, ...prev.filter((c) => c.id !== dm.id)]);
    setSelectedId(dm.id);
    return dm;
  }, []);

  const accept = useCallback(async (dmId: string) => {
    const dm = await api.acceptDMRequest(dmId);
    setRequests((prev) => prev.filter((c) => c.id !== dmId));
    setList((prev) => [dm, ...prev.filter((c) => c.id !== dmId)]);
  }, []);

  const decline = useCallback(
    async (dmId: string) => {
      await api.declineDMRequest(dmId);
      drop(dmId);
    },
    [drop],
  );

  const leave = useCallback(
    async (dmId: string) => {
      await api.leaveDM(dmId);
      drop(dmId);
    },
    [drop],
  );

  const block = useCallback(async (actorId: string) => {
    await api.blockActor(actorId);
  }, []);

  return {
    conversations,
    selectedDM,
    loading,
    selectDM,
    startDM: handleStartDM,
    accept,
    decline,
    leave,
    block,
  };
}
