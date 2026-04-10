// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface TypingIndicatorProps {
  users: AuthorView[];
}

export function TypingIndicator({ users }: TypingIndicatorProps) {
  const t = useT();
  if (users.length === 0) return null;

  const names = users.map((u) => u.displayName ?? u.preferredUsername);
  let text: string;

  if (names.length === 1) {
    text = t('typing.userIsTyping', { user: names[0] });
  } else if (names.length === 2) {
    text = t('typing.twoTyping', { user1: names[0], user2: names[1] });
  } else {
    text = t('typing.manyTyping', { user: names[0], count: names.length - 1 });
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
