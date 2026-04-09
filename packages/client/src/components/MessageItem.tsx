// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { MessageWithAuthor, IdiomAnnotation, ActorProfile } from '@babelr/shared';
import type { CachedTranslation } from '../translation';
import { EmojiPicker } from './EmojiPicker';
import { renderMarkdown } from '../utils/markdown';

interface MessageItemProps {
  data: MessageWithAuthor;
  compact: boolean;
  translation?: CachedTranslation;
  isTranslating?: boolean;
  actor?: ActorProfile;
  messageReactions?: Record<string, string[]>;
  onToggleReaction?: (emoji: string) => void;
  onReply?: () => void;
  replyCount?: number;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function ConfidenceDot({ confidence }: { confidence: number }) {
  const color = confidence > 0.8 ? '#22c55e' : confidence > 0.5 ? '#eab308' : '#ef4444';
  const label = confidence > 0.8 ? 'high' : confidence > 0.5 ? 'medium' : 'low';
  return (
    <span
      className="confidence-dot"
      style={{ backgroundColor: color }}
      title={`Translation confidence: ${label} (${Math.round(confidence * 100)}%)`}
    />
  );
}

function IdiomGlosses({ idioms }: { idioms: IdiomAnnotation[] }) {
  if (idioms.length === 0) return null;
  return (
    <div className="idiom-glosses">
      {idioms.map((idiom, i) => (
        <span
          key={i}
          className="idiom-gloss"
          title={`${idiom.explanation}${idiom.equivalent ? ` \u2192 ${idiom.equivalent}` : ''}`}
        >
          {idiom.original}
        </span>
      ))}
    </div>
  );
}

export function MessageItem({
  data,
  compact,
  translation,
  isTranslating,
  actor,
  messageReactions,
  onToggleReaction,
  onReply,
  replyCount,
}: MessageItemProps) {
  const { message, author } = data;
  const [showOriginal, setShowOriginal] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | undefined>();

  const openPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    setPickerAnchor(e.currentTarget.getBoundingClientRect());
    setShowEmojiPicker(true);
  };

  const hasTranslation = translation && !translation.skipped;
  const displayContent =
    hasTranslation && !showOriginal ? translation.translatedContent : message.content;
  const metadata = hasTranslation ? translation.metadata : undefined;

  const contentClass = ['message-content', isTranslating ? 'translating' : '']
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

  const metadataBadge = metadata ? (
    <span className="translation-metadata">
      <ConfidenceDot confidence={metadata.confidence} />
      <span className="register-intent">
        {metadata.register} {metadata.intent}
      </span>
    </span>
  ) : null;

  const idiomLine =
    metadata && metadata.idioms.length > 0 && !showOriginal ? (
      <IdiomGlosses idioms={metadata.idioms} />
    ) : null;

  if (compact) {
    return (
      <div className="message compact">
        <span className="message-time-hover">{formatTime(message.published)}</span>
        <div className={contentClass}><span dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }} /></div>
        {(indicator || metadataBadge) && (
          <div className="translation-info">
            {indicator}
            {metadataBadge}
          </div>
        )}
        {idiomLine}
      </div>
    );
  }

  const avatarEl = author.avatarUrl ? (
    <img className="message-avatar" src={author.avatarUrl} alt="" />
  ) : (
    <span
      className="message-avatar-default"
      style={{ backgroundColor: ['#2563eb','#7c3aed','#db2777','#ea580c','#16a34a','#0891b2'][author.preferredUsername.charCodeAt(0) % 6] }}
    >
      {author.preferredUsername.charAt(0).toUpperCase()}
    </span>
  );

  return (
    <div className="message">
      <div className="message-header">
        {avatarEl}
        <span className="message-author">{author.displayName ?? author.preferredUsername}</span>
        <span className="message-time">
          {formatTime(message.published)}
          {message.updated && <span className="edited-badge"> (edited)</span>}
        </span>
      </div>
      <div className={contentClass}><span dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }} /></div>
      {(indicator || metadataBadge) && (
        <div className="translation-info">
          {indicator}
          {metadataBadge}
        </div>
      )}
      {idiomLine}
      {messageReactions && Object.keys(messageReactions).length > 0 && (
        <div className="message-reactions">
          {Object.entries(messageReactions).map(([emoji, reactorIds]) => (
            <button
              key={emoji}
              className={`reaction-btn ${actor && reactorIds.includes(actor.id) ? 'reacted' : ''}`}
              onClick={() => onToggleReaction?.(emoji)}
              title={`${reactorIds.length} ${reactorIds.length === 1 ? 'reaction' : 'reactions'}`}
            >
              <span className="reaction-emoji">{emoji}</span>
              <span className="reaction-count">{reactorIds.length}</span>
            </button>
          ))}
          <button
            className="reaction-add-btn"
            onClick={openPicker}
            title="Add reaction"
          >
            +
          </button>
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(emoji) => onToggleReaction?.(emoji)}
              onClose={() => setShowEmojiPicker(false)}
              anchorRect={pickerAnchor}
            />
          )}
        </div>
      )}
      {!messageReactions && onToggleReaction && (
        <div className="message-reactions">
          <button
            className="reaction-add-btn"
            onClick={openPicker}
            title="Add reaction"
          >
            +
          </button>
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(emoji) => onToggleReaction(emoji)}
              onClose={() => setShowEmojiPicker(false)}
              anchorRect={pickerAnchor}
            />
          )}
        </div>
      )}
      <div className="message-actions">
        {onReply && (
          <button className="message-action-btn" onClick={onReply}>
            {replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
          </button>
        )}
      </div>
    </div>
  );
}
