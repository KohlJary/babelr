// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo } from 'react';
import type { EventView } from '@babelr/shared';
import { monthGridDates, isSameMonth, isSameDay } from '../utils/calendar';
import type { TranslatedEventFields } from '../hooks/useEventTranslation';

interface EventsMonthViewProps {
  anchor: Date;
  events: EventView[];
  translations: Map<string, TranslatedEventFields>;
  onSelectEvent: (event: EventView) => void;
}

/**
 * 6-row × 7-col calendar grid view. Each cell shows its date
 * number and up to `MAX_VISIBLE` event summaries; additional
 * events collapse into a "+N more" indicator.
 *
 * Multi-day events are not yet spanned across cells — each event
 * appears on its start date only. Spanning is tracked as a
 * polish-pass enhancement; for v1 this keeps the cell-rendering
 * math simple and handles the common case (single-day meetings)
 * cleanly.
 */

const MAX_VISIBLE_PER_DAY = 3;
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Group events by the local-time date of their start, returning a
 * map from "YYYY-MM-DD" to the ordered list of events that begin
 * on that day. Using a string key instead of a Date key avoids
 * reference-equality pitfalls — two `new Date()` for the same day
 * aren't `===`, and string keys are cheap to hash.
 */
function groupByDay(events: EventView[]): Map<string, EventView[]> {
  const out = new Map<string, EventView[]>();
  for (const ev of events) {
    const start = new Date(ev.startAt);
    const key = `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
    const list = out.get(key) ?? [];
    list.push(ev);
    out.set(key, list);
  }
  // Sort each day's events by start time so "earliest first" is
  // the visual order in every cell.
  for (const list of out.values()) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
  }
  return out;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatHourMinute(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function EventsMonthView({
  anchor,
  events,
  translations,
  onSelectEvent,
}: EventsMonthViewProps) {
  const dates = useMemo(() => monthGridDates(anchor), [anchor]);
  const eventsByDay = useMemo(() => groupByDay(events), [events]);
  const today = useMemo(() => new Date(), []);

  return (
    <div className="events-month-view">
      <div className="events-month-weekday-row">
        {WEEKDAY_HEADERS.map((label) => (
          <div key={label} className="events-month-weekday">
            {label}
          </div>
        ))}
      </div>
      <div className="events-month-grid">
        {dates.map((date) => {
          const inCurrentMonth = isSameMonth(date, anchor);
          const isToday = isSameDay(date, today);
          const cellEvents = eventsByDay.get(dayKey(date)) ?? [];
          const visible = cellEvents.slice(0, MAX_VISIBLE_PER_DAY);
          const overflow = cellEvents.length - visible.length;
          return (
            <div
              key={date.toISOString()}
              className={[
                'events-month-cell',
                inCurrentMonth ? '' : 'outside-month',
                isToday ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="events-month-cell-date">{date.getDate()}</div>
              <div className="events-month-cell-events">
                {visible.map((ev) => {
                  const trans = translations.get(ev.id);
                  const displayTitle = trans?.title ?? ev.title;
                  return (
                    <button
                      key={ev.id}
                      className="events-month-event"
                      onClick={() => onSelectEvent(ev)}
                      title={displayTitle}
                    >
                      <span className="events-month-event-time">
                        {formatHourMinute(ev.startAt)}
                      </span>
                      <span className="events-month-event-title">{displayTitle}</span>
                    </button>
                  );
                })}
                {overflow > 0 && (
                  <div className="events-month-overflow">+{overflow} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

