// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useRef } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: MessageWithAuthor[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

export function MessageList({ messages, loading, hasMore, onLoadMore }: MessageListProps) {
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
        return <MessageItem key={item.message.id} data={item} compact={compact} />;
      })}
      <div ref={bottomRef} />
    </div>
  );
}
