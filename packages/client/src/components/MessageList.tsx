// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useRef } from 'react';
import type { MessageWithAuthor, ActorProfile } from '@babelr/shared';
import type { CachedTranslation } from '../translation';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: MessageWithAuthor[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  translations: Map<string, CachedTranslation>;
  isTranslating: (messageId: string) => boolean;
  actor?: ActorProfile;
  messageReactions?: Map<string, Record<string, string[]>>;
  onToggleReaction?: (messageId: string, emoji: string) => void;
  onOpenThread?: (messageId: string) => void;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  callerRole?: string;
}

export function MessageList({
  messages,
  loading,
  hasMore,
  onLoadMore,
  translations,
  isTranslating,
  actor,
  messageReactions,
  onToggleReaction,
  onOpenThread,
  onEditMessage,
  onDeleteMessage,
  callerRole,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Track if user is near bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    shouldAutoScroll.current = atBottom;
  };

  // Auto-scroll on new messages
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  if (loading) {
    return <div className="message-list loading">Loading messages...</div>;
  }

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {hasMore && (
        <button className="load-more" onClick={onLoadMore}>
          Load older messages
        </button>
      )}
      {messages.length === 0 && (
        <div className="no-messages">No messages yet. Say something!</div>
      )}
      {messages.map((item, i) => {
        const prevItem = i > 0 ? messages[i - 1] : null;
        const compact = prevItem?.author.id === item.author.id;
        return (
          <MessageItem
            key={item.message.id}
            data={item}
            compact={compact}
            translation={translations.get(item.message.id)}
            isTranslating={isTranslating(item.message.id)}
            actor={actor}
            messageReactions={messageReactions?.get(item.message.id)}
            onToggleReaction={
              onToggleReaction ? (emoji) => onToggleReaction(item.message.id, emoji) : undefined
            }
            onReply={onOpenThread ? () => onOpenThread(item.message.id) : undefined}
            replyCount={item.message.replyCount}
            onEdit={onEditMessage ? (content) => onEditMessage(item.message.id, content) : undefined}
            onDelete={onDeleteMessage ? () => onDeleteMessage(item.message.id) : undefined}
            canDelete={
              actor?.id === item.message.authorId ||
              ['owner', 'admin', 'moderator'].includes(callerRole ?? '')
            }
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
