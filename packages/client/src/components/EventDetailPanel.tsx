// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo, useState } from 'react';
import type { EventView, EventRsvpStatus, ActorProfile, ChannelView } from '@babelr/shared';
import { useChat } from '../hooks/useChat';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useTranslation } from '../hooks/useTranslation';
import { useEventTranslation } from '../hooks/useEventTranslation';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { useT } from '../i18n/I18nProvider';

interface EventDetailPanelProps {
  event: EventView;
  actor: ActorProfile;
  channels?: ChannelView[];
  onClose: () => void;
  onRsvp: (status: EventRsvpStatus) => Promise<void>;
  onDelete?: () => Promise<void>;
  onGoToChannel?: (channelId: string) => void;
}

function formatDateRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = start.toDateString() === end.toDateString();
  const dateStr = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: start.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
  const startTime = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const endTime = end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${dateStr}, ${startTime} – ${endTime}`;
  const endDate = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${dateStr} ${startTime} – ${endDate} ${endTime}`;
}

export function EventDetailPanel({
  event,
  actor,
  channels,
  onClose,
  onRsvp,
  onDelete,
  onGoToChannel,
}: EventDetailPanelProps) {
  const t = useT();

  // Embedded event chat via the existing channel message pipeline
  const {
    messages,
    loading: messagesLoading,
    hasMore,
    connected,
    sendMessage,
    loadMore,
    typingUsers,
    notifyTyping,
    updateMessageContent,
    removeMessage,
  } = useChat(actor, event.eventChatId, false);
  void updateMessageContent;
  void removeMessage;

  const { settings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);

  // Translate the event's own title + description. The single-event
  // list is mostly a cache hit after EventsPanel already fetched the
  // title, so the extra cost here is just the description if any.
  const singleEventList = useMemo(() => [event], [event]);
  const { translations: eventFieldTranslations, isTranslating: eventFieldsLoading } =
    useEventTranslation(singleEventList, settings);
  const eventTrans = eventFieldTranslations.get(event.id);

  const [showOriginal, setShowOriginal] = useState(false);
  const displayTitle =
    showOriginal || !eventTrans ? event.title : eventTrans.title;
  const displayDescription =
    showOriginal || !eventTrans
      ? event.description
      : eventTrans.description ?? event.description;
  const hasTranslation = eventTrans?.anyTranslated ?? false;

  const linkedChannel = useMemo(
    () => (event.channelId ? channels?.find((c) => c.id === event.channelId) : undefined),
    [event.channelId, channels],
  );

  const isCreator = event.createdBy.id === actor.id;
  const canDelete = isCreator || !!onDelete;

  const going = event.attendees.filter((a) => a.status === 'going');
  const interested = event.attendees.filter((a) => a.status === 'interested');
  const declined = event.attendees.filter((a) => a.status === 'declined');

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm(t('events.deleteConfirm'))) return;
    await onDelete();
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel settings-panel-wide event-detail-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{displayTitle}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-tab-content">
          <div className="event-meta">
            <div className="event-meta-row">
              <span className="event-meta-label">{t('events.startAt')}:</span>
              <span>{formatDateRange(event.startAt, event.endAt)}</span>
            </div>
            {event.rrule && (
              <div className="event-meta-row">
                <span className="event-meta-label">{t('events.recurrence')}:</span>
                <span className="event-recurrence-badge">{t('events.recurringBadge')}</span>
              </div>
            )}
            {event.location && (
              <div className="event-meta-row">
                <span className="event-meta-label">{t('events.location')}:</span>
                <span>{event.location}</span>
              </div>
            )}
            <div className="event-meta-row">
              <span className="event-meta-label">
                {t('events.createdBy', {
                  user: event.createdBy.displayName ?? event.createdBy.preferredUsername,
                })}
              </span>
            </div>
            {linkedChannel && onGoToChannel && (
              <div className="event-meta-row">
                <button
                  className="friends-btn accept"
                  onClick={() => onGoToChannel(linkedChannel.id)}
                >
                  {t('events.goToChannel')} #{linkedChannel.name}
                </button>
              </div>
            )}
            {(eventFieldsLoading || hasTranslation) && (
              <div className="event-meta-row event-translation-row">
                {eventFieldsLoading && !hasTranslation && (
                  <span className="event-translation-loading">
                    {t('events.translating')}
                  </span>
                )}
                {hasTranslation && eventTrans && (
                  <button
                    type="button"
                    className="event-translation-toggle"
                    onClick={() => setShowOriginal((v) => !v)}
                  >
                    {showOriginal
                      ? t('events.showTranslation', {
                          lang: eventTrans.detectedLanguage,
                        })
                      : t('events.showOriginal', {
                          lang: eventTrans.detectedLanguage,
                        })}
                  </button>
                )}
              </div>
            )}
          </div>

          {displayDescription && (
            <div className="event-description">{displayDescription}</div>
          )}

          <div className="settings-divider" />

          <div className="event-rsvp-row">
            <button
              className={`friends-btn ${event.myRsvp === 'going' ? 'accept' : ''}`}
              onClick={() => onRsvp('going')}
            >
              {t('events.rsvpGoing')}
            </button>
            <button
              className={`friends-btn ${event.myRsvp === 'interested' ? 'accept' : ''}`}
              onClick={() => onRsvp('interested')}
            >
              {t('events.rsvpInterested')}
            </button>
            <button
              className={`friends-btn ${event.myRsvp === 'declined' ? 'decline' : ''}`}
              onClick={() => onRsvp('declined')}
            >
              {t('events.rsvpDeclined')}
            </button>
            {canDelete && (
              <button className="friends-btn decline" style={{ marginLeft: 'auto' }} onClick={handleDelete}>
                {t('common.delete')}
              </button>
            )}
          </div>

          <div className="event-attendees-section">
            <h3 className="friends-section-header">
              {t('events.attendees')} ({going.length + interested.length})
            </h3>
            {event.attendees.length === 0 && (
              <div className="sidebar-empty">{t('events.noAttendees')}</div>
            )}
            {going.length > 0 && (
              <div className="event-attendee-group">
                <span className="event-attendee-label">{t('events.rsvpGoing')}</span>
                <span>
                  {going
                    .map((a) => a.actor.displayName ?? a.actor.preferredUsername)
                    .join(', ')}
                </span>
              </div>
            )}
            {interested.length > 0 && (
              <div className="event-attendee-group">
                <span className="event-attendee-label">{t('events.rsvpInterested')}</span>
                <span>
                  {interested
                    .map((a) => a.actor.displayName ?? a.actor.preferredUsername)
                    .join(', ')}
                </span>
              </div>
            )}
            {declined.length > 0 && (
              <div className="event-attendee-group event-attendee-declined">
                <span className="event-attendee-label">{t('events.rsvpDeclined')}</span>
                <span>
                  {declined
                    .map((a) => a.actor.displayName ?? a.actor.preferredUsername)
                    .join(', ')}
                </span>
              </div>
            )}
          </div>

          <div className="settings-divider" />

          <h3 className="friends-section-header">{t('events.eventChat')}</h3>
          <div className="event-chat-embed">
            <MessageList
              messages={messages}
              loading={messagesLoading}
              hasMore={hasMore}
              onLoadMore={loadMore}
              translations={translations}
              isTranslating={isTranslating}
              actor={actor}
            />
            <TypingIndicator users={typingUsers} />
            <MessageInput
              onSend={sendMessage}
              disabled={!connected}
              onTyping={notifyTyping}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
