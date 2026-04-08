// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from '@babelr/shared';

interface TypingIndicatorProps {
  users: AuthorView[];
}

export function TypingIndicator({ users }: TypingIndicatorProps) {
  if (users.length === 0) return null;

  const names = users.map((u) => u.displayName ?? u.preferredUsername);
  let text: string;

  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing`;
  }

  return (
    <div className="typing-indicator">
      <span className="typing-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="typing-text">{text}</span>
    </div>
  );
}
