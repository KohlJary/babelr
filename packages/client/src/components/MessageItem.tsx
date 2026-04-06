// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageWithAuthor } from '@babelr/shared';

interface MessageItemProps {
  data: MessageWithAuthor;
  compact: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function MessageItem({ data, compact }: MessageItemProps) {
  const { message, author } = data;

  if (compact) {
    return (
      <div className="message compact">
        <span className="message-time-hover">{formatTime(message.published)}</span>
        <div className="message-content">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="message">
      <div className="message-header">
        <span className="message-author">{author.displayName ?? author.preferredUsername}</span>
        <span className="message-time">{formatTime(message.published)}</span>
      </div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}
