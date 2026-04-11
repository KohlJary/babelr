// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo } from 'react';
import type { EventView } from '@babelr/shared';
import { weekDates, isSameDay } from '../utils/calendar';
import type { TranslatedEventFields } from '../hooks/useEventTranslation';

interface EventsWeekViewProps {
  anchor: Date;
  events: EventView[];
  translations: Map<string, TranslatedEventFields>;
  onSelectEvent: (event: EventView) => void;
}

/**
 * Google-Calendar-shape week view. 7-day columns with an hour
 * scale on the left. Events render as absolutely-positioned blocks
 * inside their day column, with `top` proportional to start time
 * and `height` proportional to duration.
 *
 * Design decisions:
 * - **Hour range**: 6am–11pm by default (18 hours). Events outside
 *   that window clamp to the nearest edge. A future enhancement
 *   could auto-detect the range based on the user's events or let
 *   them configure it.
 * - **Multi-day events**: shown on their start day only. Spanning
 *   across columns is a deferred enhancement — the simple case
 *   covers the 90% use case of meeting-length events.
 * - **Overlapping events**: the current implementation stacks them
 *   by giving each a z-index based on sort order. Collision
 *   detection and side-by-side layout is a polish pass away.
 */

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const START_HOUR = 6;
const END_HOUR = 24;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const HOUR_HEIGHT_PX = 48;

/**
 * Convert an ISO timestamp into a vertical pixel offset inside
 * the day column, measured from the top of the displayed range.
 * Minutes contribute a fractional hour.
 */
function isoToOffsetPx(iso: string): number {
  const d = new Date(iso);
  const hour = d.getHours() + d.getMinutes() / 60;
  const clamped = Math.max(START_HOUR, Math.min(END_HOUR, hour));
  return (clamped - START_HOUR) * HOUR_HEIGHT_PX;
}

/**
 * Group events into 7 per-day lists by local-time start date.
 * Uses a string key to avoid reference-equality pitfalls with
 * Date objects. Matches the month view's groupBy pattern.
 */
function groupByDay(events: EventView[], days: Date[]): Map<string, EventView[]> {
  const out = new Map<string, EventView[]>();
  for (const d of days) {
    out.set(dayKey(d), []);
  }
  for (const ev of events) {
    const start = new Date(ev.startAt);
    const key = dayKey(start);
    const list = out.get(key);
    if (list) list.push(ev);
  }
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

export function EventsWeekView({
  anchor,
  events,
  translations,
  onSelectEvent,
}: EventsWeekViewProps) {
  const days = useMemo(() => weekDates(anchor), [anchor]);
  const eventsByDay = useMemo(() => groupByDay(events, days), [events, days]);
  const today = useMemo(() => new Date(), []);

  // Generate hour labels for the left rail
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let h = START_HOUR; h < END_HOUR; h++) out.push(h);
    return out;
  }, []);

  return (
    <div className="events-week-view">
      <div className="events-week-header">
        <div className="events-week-hour-rail-spacer" />
        {days.map((d) => {
          const isToday = isSameDay(d, today);
          return (
            <div
              key={d.toISOString()}
              className={`events-week-day-header ${isToday ? 'today' : ''}`}
            >
              <div className="events-week-day-weekday">
                {WEEKDAY_HEADERS[d.getDay()]}
              </div>
              <div className="events-week-day-date">{d.getDate()}</div>
            </div>
          );
        })}
      </div>
      <div className="events-week-body" style={{ height: TOTAL_HOURS * HOUR_HEIGHT_PX }}>
        <div className="events-week-hour-rail">
          {hours.map((h) => (
            <div
              key={h}
              className="events-week-hour-label"
              style={{ height: HOUR_HEIGHT_PX }}
            >
              {h === 12
                ? '12 PM'
                : h === 0
                  ? '12 AM'
                  : h < 12
                    ? `${h} AM`
                    : `${h - 12} PM`}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const isToday = isSameDay(d, today);
          const dayEvents = eventsByDay.get(dayKey(d)) ?? [];
          return (
            <div
              key={d.toISOString()}
              className={`events-week-day-column ${isToday ? 'today' : ''}`}
            >
              {hours.map((h) => (
                <div
                  key={h}
                  className="events-week-hour-slot"
                  style={{ height: HOUR_HEIGHT_PX }}
                />
              ))}
              {dayEvents.map((ev) => {
                const top = isoToOffsetPx(ev.startAt);
                const bottom = isoToOffsetPx(ev.endAt);
                const height = Math.max(18, bottom - top); // min 18px so tiny events stay clickable
                const trans = translations.get(ev.id);
                const displayTitle = trans?.title ?? ev.title;
                return (
                  <button
                    key={ev.id}
                    className="events-week-event"
                    style={{ top, height }}
                    onClick={() => onSelectEvent(ev)}
                    title={displayTitle}
                  >
                    <div className="events-week-event-title">{displayTitle}</div>
                    <div className="events-week-event-time">
                      {formatHourMinute(ev.startAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
