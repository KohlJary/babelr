// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useMemo } from 'react';
import type { EventView, ActorProfile, ChannelView } from '@babelr/shared';
import { useEvents } from '../hooks/useEvents';
import { CreateEventModal } from './CreateEventModal';
import { EventDetailPanel } from './EventDetailPanel';
import { useT } from '../i18n/I18nProvider';

interface EventsPanelProps {
  scope: 'user' | 'server';
  ownerId: string;
  ownerName?: string;
  actor: ActorProfile;
  channels?: ChannelView[];
  canCreate: boolean;
  onClose: () => void;
  onGoToChannel?: (channelId: string) => void;
}

/** Bucket events into Today / Tomorrow / This week / Later. */
function bucketEvents(events: EventView[]): {
  today: EventView[];
  tomorrow: EventView[];
  thisWeek: EventView[];
  later: EventView[];
} {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfDayAfter = new Date(startOfToday);
  startOfDayAfter.setDate(startOfDayAfter.getDate() + 2);
  const startOfNextWeek = new Date(startOfToday);
  startOfNextWeek.setDate(startOfNextWeek.getDate() + 7);

  const today: EventView[] = [];
  const tomorrow: EventView[] = [];
  const thisWeek: EventView[] = [];
  const later: EventView[] = [];

  for (const ev of events) {
    const start = new Date(ev.startAt);
    if (start < startOfTomorrow) today.push(ev);
    else if (start < startOfDayAfter) tomorrow.push(ev);
    else if (start < startOfNextWeek) thisWeek.push(ev);
    else later.push(ev);
  }
  return { today, tomorrow, thisWeek, later };
}

function formatShortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EventsPanel({
  scope,
  ownerId,
  ownerName,
  actor,
  channels,
  canCreate,
  onClose,
  onGoToChannel,
}: EventsPanelProps) {
  const t = useT();
  const { events, loading, error, createEvent, deleteEvent, rsvpEvent } = useEvents({
    scope,
    ownerId,
  });
  const [showCreate, setShowCreate] = useState(false);
  const [detailEvent, setDetailEvent] = useState<EventView | null>(null);

  const buckets = useMemo(() => bucketEvents(events), [events]);

  const panelTitle =
    scope === 'server'
      ? `${t('events.serverCalendar')}${ownerName ? ` — ${ownerName}` : ''}`
      : t('events.myCalendar');

  const renderBucket = (label: string, list: EventView[]) => {
    if (list.length === 0) return null;
    return (
      <div className="friends-section" key={label}>
        <h3 className="friends-section-header">{label}</h3>
        {list.map((ev) => (
          <button
            key={ev.id}
            className="event-row"
            onClick={() => setDetailEvent(ev)}
          >
            <div className="event-row-main">
              <span className="event-row-title">{ev.title}</span>
              {ev.rrule && (
                <span className="event-recurrence-badge">{t('events.recurringBadge')}</span>
              )}
            </div>
            <div className="event-row-meta">
              <span>{formatShortTime(ev.startAt)}</span>
              {ev.location && <span> · {ev.location}</span>}
            </div>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel settings-panel-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{panelTitle}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-tab-content">
          {canCreate && (
            <button
              className="auth-submit"
              style={{ marginBottom: '1rem' }}
              onClick={() => setShowCreate(true)}
            >
              + {t('events.createEvent')}
            </button>
          )}

          {loading && <div className="sidebar-empty">{t('events.loading')}</div>}
          {error && <div className="dm-lookup-error">{error}</div>}
          {!loading && !error && events.length === 0 && (
            <div className="sidebar-empty">{t('events.upcomingEmpty')}</div>
          )}

          {renderBucket(t('events.today'), buckets.today)}
          {renderBucket(t('events.tomorrow'), buckets.tomorrow)}
          {renderBucket(t('events.thisWeek'), buckets.thisWeek)}
          {renderBucket(t('events.later'), buckets.later)}
        </div>

        {showCreate && (
          <CreateEventModal
            scope={scope}
            ownerId={ownerId}
            channels={scope === 'server' ? channels : undefined}
            onCreate={async (input) => {
              await createEvent(input);
            }}
            onClose={() => setShowCreate(false)}
          />
        )}

        {detailEvent && (
          <EventDetailPanel
            event={detailEvent}
            actor={actor}
            channels={channels}
            onClose={() => setDetailEvent(null)}
            onRsvp={async (status) => {
              const updated = await rsvpEvent(detailEvent.id, status);
              setDetailEvent({ ...detailEvent, ...updated });
            }}
            onDelete={
              detailEvent.createdBy.id === actor.id
                ? async () => {
                    await deleteEvent(detailEvent.id);
                    setDetailEvent(null);
                  }
                : undefined
            }
            onGoToChannel={(channelId) => {
              onGoToChannel?.(channelId);
              setDetailEvent(null);
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}
