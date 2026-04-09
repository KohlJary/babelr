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
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  canDelete?: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
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
  onEdit,
  onDelete,
  canDelete,
}: MessageItemProps) {
  const { message, author } = data;
  const [showOriginal, setShowOriginal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
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

  const props = message.properties as Record<string, unknown> | undefined;
  const messageAttachments = (props?.attachments as { url: string; filename: string; contentType: string }[]) ?? [];

  const attachmentsBlock = messageAttachments.length > 0 ? (
    <div className="message-attachments">
      {messageAttachments.map((att, i) =>
        att.contentType.startsWith('image/') ? (
          <a key={i} href={att.url} target="_blank" rel="noopener noreferrer">
            <img src={att.url} alt={att.filename} className="message-attachment-img" />
          </a>
        ) : (
          <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="message-attachment-file">
            {att.filename}
          </a>
        ),
      )}
    </div>
  ) : null;

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

  const actionsBlock = editing ? (
    <div className="message-edit-form">
      <textarea
        className="modal-input"
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        rows={2}
        style={{ resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div className="message-edit-actions">
        <button className="message-action-btn" onClick={() => { onEdit?.(editContent); setEditing(false); }}>Save</button>
        <button className="message-action-btn" onClick={() => { setEditing(false); setEditContent(message.content); }}>Cancel</button>
      </div>
    </div>
  ) : (
    <div className="message-actions">
      {onReply && (
        <button className="message-action-btn" onClick={onReply}>
          {replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
        </button>
      )}
      {onEdit && actor?.id === author.id && (
        <button className="message-action-btn" onClick={() => setEditing(true)}>Edit</button>
      )}
      {canDelete && (
        <button className="message-action-btn message-action-danger" onClick={onDelete}>Delete</button>
      )}
    </div>
  );

  const reactionsBlock = (
    <>
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
          <button className="reaction-add-btn" onClick={openPicker} title="Add reaction">+</button>
          {showEmojiPicker && (
            <EmojiPicker onSelect={(emoji) => onToggleReaction?.(emoji)} onClose={() => setShowEmojiPicker(false)} anchorRect={pickerAnchor} />
          )}
        </div>
      )}
      {!messageReactions && onToggleReaction && (
        <div className="message-reactions">
          <button className="reaction-add-btn" onClick={openPicker} title="Add reaction">+</button>
          {showEmojiPicker && (
            <EmojiPicker onSelect={(emoji) => onToggleReaction(emoji)} onClose={() => setShowEmojiPicker(false)} anchorRect={pickerAnchor} />
          )}
        </div>
      )}
    </>
  );

  if (compact) {
    return (
      <div className="message compact">
        <span className="message-time-hover">{formatTime(message.published)}</span>
        <div className={contentClass}><span dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }} /></div>
        {attachmentsBlock}
        {(indicator || metadataBadge) && (
          <div className="translation-info">
            {indicator}
            {metadataBadge}
          </div>
        )}
        {idiomLine}
        {reactionsBlock}
        {actionsBlock}
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
      {attachmentsBlock}
      {(indicator || metadataBadge) && (
        <div className="translation-info">
          {indicator}
          {metadataBadge}
        </div>
      )}
      {idiomLine}
      {reactionsBlock}
      {actionsBlock}
    </div>
  );
}
