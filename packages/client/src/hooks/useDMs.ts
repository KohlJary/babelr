// SPDX-License-Identifier: MIT
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { DMConversation, MessageView, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';
import { applyDMMessage } from './dmList';

/**
 * The DM list, kept live over the tab's one socket.
 *
 * `actorId` is who's signed in (their own messages are never unread);
 * `showing` says whether the selected DM is on screen (DM mode, no other
 * view over it), so a message arriving there isn't counted as unread.
 */
export function useDMs(actorId?: string, showing = true) {
  const [list, setList] = useState<DMConversation[]>([]);
  // Message requests waiting for my answer, listed first.
  const [requests, setRequests] = useState<DMConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Read inside the socket handler without re-subscribing it.
  const seen = useRef({ selectedId, showing, actorId });
  seen.current = { selectedId, showing, actorId };

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

  // A new message in one of my DMs: its preview, its unread mark, and the
  // conversation moves to the top. (The list subscribes to every DM below.)
  const onDMMessage = useCallback((message: MessageView, authorId: string) => {
    const { selectedId: sel, showing: on, actorId: me } = seen.current;
    const how = { mine: authorId === me, onScreen: on && sel === message.channelId };
    setList((prev) => applyDMMessage(prev, message, how));
    setRequests((prev) => applyDMMessage(prev, message, how));
    // Read where it landed: a reload mustn't call it unread.
    if (how.onScreen && !how.mine && !message.inReplyTo) {
      api.markChannelAsRead(message.channelId).catch(() => {});
    }
  }, []);

  const onDMEdit = useCallback(
    (p: { messageId: string; channelId: string; content: string; iv?: string }) => {
      const edit = (prev: DMConversation[]) =>
        prev.map((c) =>
          c.id === p.channelId && c.lastMessage?.id === p.messageId
            ? {
                ...c,
                lastMessage: {
                  ...c.lastMessage,
                  content: p.content,
                  ...(p.iv ? { properties: { ...c.lastMessage.properties, iv: p.iv } } : {}),
                },
              }
            : c,
        );
      setList(edit);
      setRequests(edit);
    },
    [],
  );

  const handleWsMessage = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === 'message:new') {
        onDMMessage(msg.payload.message, msg.payload.author.id);
      } else if (msg.type === 'message:updated') {
        onDMEdit(msg.payload);
      } else if (msg.type === 'conversation:new') {
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
    [drop, onDMMessage, onDMEdit],
  );

  const { connected, send } = useWebSocket(true, handleWsMessage);

  // Follow every DM on the shared socket, not just the open one, so a
  // message anywhere reaches the list. Subscriptions are reference-counted
  // (wsConnection.ts): the open DM's own subscription (useChat) is unaffected.
  // A reconnect drops them all, and `connected` coming back re-subscribes.
  const dmIds = useMemo(
    () => [...new Set([...list, ...requests].map((c) => c.id))].sort().join(','),
    [list, requests],
  );
  useEffect(() => {
    if (!connected || !dmIds) return;
    const ids = dmIds.split(',');
    for (const channelId of ids) send({ type: 'channel:subscribe', payload: { channelId } });
    return () => {
      for (const channelId of ids) send({ type: 'channel:unsubscribe', payload: { channelId } });
    };
  }, [dmIds, connected, send]);

  // Opening a DM reads it (useChat marks it read on the server).
  useEffect(() => {
    if (!showing || !selectedId) return;
    const clear = (prev: DMConversation[]) =>
      prev.some((c) => c.id === selectedId && c.unread)
        ? prev.map((c) => (c.id === selectedId ? { ...c, unread: 0 } : c))
        : prev;
    setList(clear);
    setRequests(clear);
  }, [selectedId, showing]);

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
