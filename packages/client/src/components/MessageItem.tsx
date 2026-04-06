// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import type { CachedTranslation } from '../translation';

interface MessageItemProps {
  data: MessageWithAuthor;
  compact: boolean;
  translation?: CachedTranslation;
  isTranslating?: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function MessageItem({ data, compact, translation, isTranslating }: MessageItemProps) {
  const { message, author } = data;
  const [showOriginal, setShowOriginal] = useState(false);

  const hasTranslation = translation && !translation.skipped;
  const displayContent =
    hasTranslation && !showOriginal ? translation.translatedContent : message.content;

  const contentClass = [
    'message-content',
    isTranslating ? 'translating' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const indicator = hasTranslation ? (
    <button
      className="translation-indicator"
      onClick={() => setShowOriginal(!showOriginal)}
      title={showOriginal ? 'Show translation' : 'Show original'}
    >
      {showOriginal
        ? `translated from ${translation.detectedLanguage}`
        : `original: ${translation.detectedLanguage}`}
    </button>
  ) : null;

  if (compact) {
    return (
      <div className="message compact">
        <span className="message-time-hover">{formatTime(message.published)}</span>
        <div className={contentClass}>{displayContent}</div>
        {indicator}
      </div>
    );
  }

  return (
    <div className="message">
      <div className="message-header">
        <span className="message-author">{author.displayName ?? author.preferredUsername}</span>
        <span className="message-time">{formatTime(message.published)}</span>
      </div>
      <div className={contentClass}>{displayContent}</div>
      {indicator}
    </div>
  );
}
