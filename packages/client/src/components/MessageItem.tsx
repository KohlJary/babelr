// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { MessageWithAuthor, IdiomAnnotation, ActorProfile } from '@babelr/shared';
import type { CachedTranslation } from '../translation';
import { EmojiPicker } from './EmojiPicker';
import { renderWithEmbeds } from '../utils/render-with-embeds';
import type { MessageEmbedView, EventEmbedView, FileEmbedView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';
import type { UIStringKey } from '@babelr/shared';

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
  /** Seed a new wiki page from this message's content */
  onConvertToWikiPage?: () => void;
  /** Called when the user clicks an inline message embed to navigate to the source. */
  onNavigateMessageEmbed?: (embed: MessageEmbedView) => void;
  /** Called when the user clicks an inline event embed to open the event panel. */
  onNavigateEventEmbed?: (embed: EventEmbedView) => void;
  /** Called when the user clicks an inline file embed to open the files panel. */
  onNavigateFileEmbed?: (embed: FileEmbedView) => void;
}

type TFn = (key: UIStringKey, values?: Record<string, string | number>) => string;

function formatTime(iso: string, t: TFn): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (isToday) return t('messages.todayAt', { time });
  if (isYesterday) return t('messages.yesterdayAt', { time });
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

function ConfidenceDot({ confidence, t }: { confidence: number; t: TFn }) {
  const color = confidence > 0.8 ? '#22c55e' : confidence > 0.5 ? '#eab308' : '#ef4444';
  const label =
    confidence > 0.8
      ? t('messages.confidenceHigh')
      : confidence > 0.5
        ? t('messages.confidenceMedium')
        : t('messages.confidenceLow');
  return (
    <span
      className="confidence-dot"
      style={{ backgroundColor: color }}
      title={t('messages.translationConfidence', { label, percent: Math.round(confidence * 100) })}
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
  onConvertToWikiPage,
  onNavigateMessageEmbed,
  onNavigateEventEmbed,
  onNavigateFileEmbed,
}: MessageItemProps) {
  const t = useT();
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
      title={showOriginal ? t('messages.showTranslation') : t('messages.showOriginal')}
    >
      {showOriginal
        ? t('messages.translatedFromLang', { lang: translation.detectedLanguage })
        : t('messages.originalLang', { lang: translation.detectedLanguage })}
    </button>
  ) : null;

  const metadataBadge = metadata ? (
    <span className="translation-metadata">
      <ConfidenceDot confidence={metadata.confidence} t={t} />
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
        <button className="message-action-btn" onClick={() => { onEdit?.(editContent); setEditing(false); }}>{t('common.save')}</button>
        <button className="message-action-btn" onClick={() => { setEditing(false); setEditContent(message.content); }}>{t('common.cancel')}</button>
      </div>
    </div>
  ) : (
    <div className="message-actions">
      {onReply && (
        <button className="message-action-btn" onClick={onReply}>
          {replyCount
            ? replyCount === 1
              ? t('messages.replyOne', { count: replyCount })
              : t('messages.replyMany', { count: replyCount })
            : t('messages.reply')}
        </button>
      )}
      {onEdit && actor?.id === author.id && (
        <button className="message-action-btn" onClick={() => setEditing(true)}>{t('messages.edit')}</button>
      )}
      {canDelete && (
        <button className="message-action-btn message-action-danger" onClick={onDelete}>{t('messages.delete')}</button>
      )}
      {onConvertToWikiPage && (
        <button
          className="message-action-btn"
          onClick={onConvertToWikiPage}
          title={t('wiki.convertMessage')}
        >
          {t('wiki.convertMessage')}
        </button>
      )}
      {message.slug && (
        <button
          className="message-action-btn"
          onClick={async () => {
            const text = `[[msg:${message.slug}]]`;
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              const ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand('copy');
              } catch {
                /* nothing more we can do */
              }
              document.body.removeChild(ta);
            }
          }}
          title={t('messages.copyReference')}
        >
          {t('messages.copyReference')}
        </button>
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
              title={
                reactorIds.length === 1
                  ? t('messages.reactionCountOne', { count: reactorIds.length })
                  : t('messages.reactionCountMany', { count: reactorIds.length })
              }
            >
              <span className="reaction-emoji">{emoji}</span>
              <span className="reaction-count">{reactorIds.length}</span>
            </button>
          ))}
          <button className="reaction-add-btn" onClick={openPicker} title={t('messages.addReaction')}>+</button>
          {showEmojiPicker && (
            <EmojiPicker onSelect={(emoji) => onToggleReaction?.(emoji)} onClose={() => setShowEmojiPicker(false)} anchorRect={pickerAnchor} />
          )}
        </div>
      )}
      {!messageReactions && onToggleReaction && (
        <div className="message-reactions">
          <button className="reaction-add-btn" onClick={openPicker} title={t('messages.addReaction')}>+</button>
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
        <span className="message-time-hover">{formatTime(message.published, t)}</span>
        <div className={contentClass}>
          {renderWithEmbeds(displayContent, {
            variant: 'chat',
            onNavigateMessage: onNavigateMessageEmbed,
            onNavigateEvent: onNavigateEventEmbed,
            onNavigateFile: onNavigateFileEmbed,
            actor,
          })}
        </div>
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
          {formatTime(message.published, t)}
          {message.updated && <span className="edited-badge"> {t('messages.edited')}</span>}
        </span>
      </div>
      <div className={contentClass}>
        {renderWithEmbeds(displayContent, {
          variant: 'chat',
          onNavigateMessage: onNavigateMessageEmbed,
          onNavigateEvent: onNavigateEventEmbed,
        })}
      </div>
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
