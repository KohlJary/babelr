// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ActorProfile, AuthorView, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
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
  type TypingEntry = { actor: AuthorView; timeout: ReturnType<typeof setTimeout> };
  const [typingMap, setTypingMap] = useState<Map<string, TypingEntry>>(() => new Map());
  const e2eRef = useRef(e2eOptions);
  e2eRef.current = e2eOptions;
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const typingUsers = useMemo(() => Array.from(typingMap.values()).map((v) => v.actor), [typingMap]);

  const handleWsMessage = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === 'message:updated') {
        setMessages((prev) =>
          prev.map((m) =>
            m.message.id === msg.payload.messageId
              ? {
                  ...m,
                  message: {
                    ...m.message,
                    content: msg.payload.content,
                    updated: msg.payload.updatedAt,
                  },
                }
              : m,
          ),
        );
      } else if (msg.type === 'message:deleted') {
        setMessages((prev) =>
          prev.filter((m) => m.message.id !== msg.payload.messageId),
        );
      } else if (msg.type === 'message:new') {
        const e2e = e2eRef.current;
        if (isDM && e2e?.e2e.ready && msg.payload.message.properties?.encrypted) {
          e2e.e2e.decryptMsg(msg.payload).then((decrypted) => {
            setMessages((prev) => [...prev, decrypted]);
          });
        } else {
          setMessages((prev) => [...prev, msg.payload]);
        }
        // Clear typing indicator when user sends a message
        if (msg.payload.author) {
          setTypingMap((prev) => {
            const next = new Map(prev);
            const entry = next.get(msg.payload.author.id);
            if (entry) clearTimeout(entry.timeout);
            next.delete(msg.payload.author.id);
            return next;
          });
        }
      } else if (msg.type === 'typing:start') {
        const { actor: typingActor } = msg.payload;
        setTypingMap((prev) => {
          const next = new Map(prev);
          const existing = next.get(typingActor.id);
          if (existing) clearTimeout(existing.timeout);
          const timeout = setTimeout(() => {
            setTypingMap((p) => {
              const n = new Map(p);
              n.delete(typingActor.id);
              return n;
            });
          }, 3000);
          next.set(typingActor.id, { actor: typingActor, timeout });
          return next;
        });
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

    // Mark channel as read when viewing
    if (!isDM) {
      api.markChannelAsRead(channelId).catch((err) => {
        console.error('Failed to mark as read:', err);
      });
    }
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
    async (content: string, attachments?: { url: string; filename: string; contentType: string }[]) => {
      if (!channelId) return;

      const properties: Record<string, unknown> = {};
      if (attachments && attachments.length > 0) {
        properties.attachments = attachments;
      }

      const e2e = e2eRef.current;
      if (isDM && e2e?.e2e.ready) {
        const encrypted = await e2e.e2e.encrypt(content, e2e.recipientId);
        await api.sendMessage(channelId, encrypted.ciphertext, true, {
          encrypted: true,
          iv: encrypted.iv,
          ...properties,
        });
      } else {
        const hasProps = Object.keys(properties).length > 0;
        await api.sendMessage(channelId, content, isDM, hasProps ? properties : undefined);
      }
    },
    [channelId, isDM],
  );

  const notifyTyping = useCallback(() => {
    if (!channelId || !connected) return;
    if (typingDebounceRef.current) return; // Already sent recently
    send({ type: 'typing:start', payload: { channelId } });
    typingDebounceRef.current = setTimeout(() => {
      typingDebounceRef.current = undefined;
    }, 2000);
  }, [channelId, connected, send]);

  const updateMessageContent = useCallback((messageId: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.message.id === messageId
          ? { ...m, message: { ...m.message, content, updated: new Date().toISOString() } }
          : m,
      ),
    );
  }, []);

  const removeMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.message.id !== messageId));
  }, []);

  return {
    messages,
    loading,
    hasMore,
    connected,
    sendMessage,
    loadMore,
    typingUsers,
    notifyTyping,
    updateMessageContent,
    removeMessage,
  };
}
