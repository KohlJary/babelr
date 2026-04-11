// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useMemo, useEffect } from 'react';
import * as api from '../api';
import type { EventView, ActorProfile, ChannelView } from '@babelr/shared';
import { useEvents } from '../hooks/useEvents';
import { useEventTranslation } from '../hooks/useEventTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { CreateEventModal } from './CreateEventModal';
import { EventDetailPanel } from './EventDetailPanel';
import { EventsWeekView } from './EventsWeekView';
import { EventsMonthView } from './EventsMonthView';
import {
  addDays,
  addMonths,
  formatMonthHeader,
  formatWeekHeader,
  startOfMonthGrid,
  endOfMonthGrid,
  startOfWeek,
  endOfWeek,
} from '../utils/calendar';
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
  /**
   * If set, the panel auto-opens the detail view for this event on
   * mount. Used when the user clicks an `[[event:slug]]` embed —
   * ChatView resolves the slug → id, flips to calendar view, and
   * passes the id here.
   */
  initialEventId?: string | null;
}

type ViewMode = 'agenda' | 'week' | 'month';

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
  initialEventId,
}: EventsPanelProps) {
  const t = useT();

  // View state. `anchor` is the date we're centered on for
  // week/month views — navigation shifts it by ±1 unit and "Today"
  // resets it to now.
  const [viewMode, setViewMode] = useState<ViewMode>('agenda');
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  // Compute the time window to fetch based on the active view.
  // Agenda uses the server default (now → 60d). Week and month
  // pass explicit bounds so past events and far-future events
  // show up when the user navigates there.
  const range = useMemo(() => {
    if (viewMode === 'week') {
      return {
        rangeStart: startOfWeek(anchor).toISOString(),
        rangeEnd: endOfWeek(anchor).toISOString(),
      };
    }
    if (viewMode === 'month') {
      return {
        rangeStart: startOfMonthGrid(anchor).toISOString(),
        rangeEnd: endOfMonthGrid(anchor).toISOString(),
      };
    }
    return { rangeStart: undefined, rangeEnd: undefined };
  }, [viewMode, anchor]);

  const { events, loading, error, createEvent, deleteEvent, rsvpEvent } = useEvents({
    scope,
    ownerId,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
  });
  const { settings: translationSettings } = useTranslationSettings();
  const { translations: eventTranslations } = useEventTranslation(events, translationSettings);
  const [showCreate, setShowCreate] = useState(false);
  const [detailEvent, setDetailEvent] = useState<EventView | null>(null);

  // Auto-open the detail view if the panel was launched with a
  // specific event id (e.g. from clicking an `[[event:slug]]` embed).
  // We fetch the full EventView since the embed only carried a
  // compact shape, and we can't assume the event is in the current
  // range-bounded events list.
  useEffect(() => {
    if (!initialEventId) return;
    let cancelled = false;
    void api
      .getEvent(initialEventId)
      .then((ev) => {
        if (!cancelled) setDetailEvent(ev);
      })
      .catch(() => {
        /* 404/403 — silently no-op; the clicked embed was stale or forbidden */
      });
    return () => {
      cancelled = true;
    };
  }, [initialEventId]);

  const buckets = useMemo(() => bucketEvents(events), [events]);

  const panelTitle =
    scope === 'server'
      ? `${t('events.serverCalendar')}${ownerName ? ` — ${ownerName}` : ''}`
      : t('events.myCalendar');

  // Navigation helpers for week/month views.
  const goPrev = () => {
    if (viewMode === 'week') setAnchor(addDays(anchor, -7));
    else if (viewMode === 'month') setAnchor(addMonths(anchor, -1));
  };
  const goNext = () => {
    if (viewMode === 'week') setAnchor(addDays(anchor, 7));
    else if (viewMode === 'month') setAnchor(addMonths(anchor, 1));
  };
  const goToday = () => setAnchor(new Date());

  const rangeHeader =
    viewMode === 'week'
      ? formatWeekHeader(anchor)
      : viewMode === 'month'
        ? formatMonthHeader(anchor)
        : '';

  const renderBucket = (label: string, list: EventView[]) => {
    if (list.length === 0) return null;
    return (
      <div className="friends-section" key={label}>
        <h3 className="friends-section-header">{label}</h3>
        {list.map((ev) => {
          const trans = eventTranslations.get(ev.id);
          const displayTitle = trans?.title ?? ev.title;
          return (
            <button
              key={ev.id}
              className="event-row"
              onClick={() => setDetailEvent(ev)}
            >
              <div className="event-row-main">
                <span className="event-row-title">{displayTitle}</span>
                {ev.rrule && (
                  <span className="event-recurrence-badge">{t('events.recurringBadge')}</span>
                )}
              </div>
              <div className="event-row-meta">
                <span>{formatShortTime(ev.startAt)}</span>
                {ev.location && <span> · {ev.location}</span>}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="inline-main-view events-panel-shell">
      <div className="inline-main-header">
        <h2>{panelTitle}</h2>
        <button className="settings-close" onClick={onClose} title={t('events.backToChat')}>
          &times;
        </button>
      </div>

        <div className="events-view-toolbar">
          <div className="events-view-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`events-view-tab ${viewMode === 'agenda' ? 'active' : ''}`}
              onClick={() => setViewMode('agenda')}
            >
              {t('events.viewAgenda')}
            </button>
            <button
              type="button"
              role="tab"
              className={`events-view-tab ${viewMode === 'week' ? 'active' : ''}`}
              onClick={() => setViewMode('week')}
            >
              {t('events.viewWeek')}
            </button>
            <button
              type="button"
              role="tab"
              className={`events-view-tab ${viewMode === 'month' ? 'active' : ''}`}
              onClick={() => setViewMode('month')}
            >
              {t('events.viewMonth')}
            </button>
          </div>
          {viewMode !== 'agenda' && (
            <div className="events-view-nav">
              <button type="button" className="events-view-nav-btn" onClick={goPrev} title={t('events.previous')}>
                ‹
              </button>
              <button type="button" className="events-view-nav-btn events-view-today" onClick={goToday}>
                {t('events.today')}
              </button>
              <button type="button" className="events-view-nav-btn" onClick={goNext} title={t('events.next')}>
                ›
              </button>
              <span className="events-view-range-label">{rangeHeader}</span>
            </div>
          )}
          {canCreate && (
            <button
              className="auth-submit events-view-create-btn"
              onClick={() => setShowCreate(true)}
            >
              + {t('events.createEvent')}
            </button>
          )}
        </div>

        <div className="settings-tab-content events-panel-content">
          {loading && <div className="sidebar-empty">{t('events.loading')}</div>}
          {error && <div className="dm-lookup-error">{error}</div>}

          {viewMode === 'agenda' && (
            <>
              {!loading && !error && events.length === 0 && (
                <div className="sidebar-empty">{t('events.upcomingEmpty')}</div>
              )}
              {renderBucket(t('events.today'), buckets.today)}
              {renderBucket(t('events.tomorrow'), buckets.tomorrow)}
              {renderBucket(t('events.thisWeek'), buckets.thisWeek)}
              {renderBucket(t('events.later'), buckets.later)}
            </>
          )}

          {viewMode === 'week' && !loading && !error && (
            <EventsWeekView
              anchor={anchor}
              events={events}
              translations={eventTranslations}
              onSelectEvent={setDetailEvent}
            />
          )}

          {viewMode === 'month' && !loading && !error && (
            <EventsMonthView
              anchor={anchor}
              events={events}
              translations={eventTranslations}
              onSelectEvent={setDetailEvent}
            />
          )}
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
  );
}
