// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ActorProfile, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';
import type { E2EContext } from './useE2E';

interface E2EOptions {
  e2e: E2EContext;
  recipientId: string;
}

export function useChat(
  actor: ActorProfile,
  channelId: string | null,
  isDM = false,
  e2eOptions?: E2EOptions,
) {
  const [messages, setMessages] = useState<MessageWithAuthor[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const e2eRef = useRef(e2eOptions);
  e2eRef.current = e2eOptions;

  const handleWsMessage = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === 'message:new') {
        const e2e = e2eRef.current;
        if (isDM && e2e?.e2e.ready && msg.payload.message.properties?.encrypted) {
          e2e.e2e.decryptMsg(msg.payload).then((decrypted) => {
            setMessages((prev) => [...prev, decrypted]);
          });
        } else {
          setMessages((prev) => [...prev, msg.payload]);
        }
      }
    },
    [isDM],
  );

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

    api.getMessages(channelId, undefined, isDM).then(async (res) => {
      let msgs = res.messages.reverse();

      // Decrypt DM history if E2E is available
      const e2e = e2eRef.current;
      if (isDM && e2e?.e2e.ready) {
        msgs = await e2e.e2e.decryptMsgs(msgs);
      }

      setMessages(msgs);
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
    let msgs = res.messages.reverse();

    const e2e = e2eRef.current;
    if (isDM && e2e?.e2e.ready) {
      msgs = await e2e.e2e.decryptMsgs(msgs);
    }

    setMessages((prev) => [...msgs, ...prev]);
    setHasMore(res.hasMore);
    if (res.cursor) setCursor(res.cursor);
  }, [channelId, cursor, hasMore, isDM]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!channelId) return;

      const e2e = e2eRef.current;
      if (isDM && e2e?.e2e.ready) {
        const encrypted = await e2e.e2e.encrypt(content, e2e.recipientId);
        await api.sendMessage(channelId, encrypted.ciphertext, true, {
          encrypted: true,
          iv: encrypted.iv,
        });
      } else {
        await api.sendMessage(channelId, content, isDM);
      }
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
