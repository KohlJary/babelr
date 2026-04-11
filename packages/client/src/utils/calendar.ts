// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Tiny calendar math helpers shared between the week and month
 * views. All functions are pure and operate on `Date` objects with
 * the user's local timezone — appropriate for a calendar UI where
 * "today" should mean the user's local today.
 *
 * No external date library. If we ever grow timezone-aware event
 * display or recurrence-rule editing, we can upgrade to date-fns
 * or Temporal. For now a handful of pure functions covers the
 * whole surface.
 */

/** Midnight on the given date in local time. */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Midnight at the start of the next day. */
export function startOfNextDay(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Sunday at 00:00 of the week containing the given date. We use
 * Sunday-start because it matches most common US calendar UIs and
 * keeps the month grid math simpler. A future locale-aware option
 * could make this configurable.
 */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay()); // Sunday = 0
  return d;
}

/** Saturday at 23:59:59.999 of the week containing the given date. */
export function endOfWeek(date: Date): Date {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setMilliseconds(-1);
  return end;
}

/** First day of the month containing the given date. */
export function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

/** Last millisecond of the month containing the given date. */
export function endOfMonth(date: Date): Date {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + 1);
  d.setMilliseconds(-1);
  return d;
}

/**
 * Start of the 6-row × 7-col month grid — the Sunday on or before
 * the first of the month. Some months have their 1st on a Sunday
 * and the grid starts exactly there; others have the 1st mid-week
 * and the grid starts in the previous month.
 */
export function startOfMonthGrid(date: Date): Date {
  return startOfWeek(startOfMonth(date));
}

/**
 * End of the month grid — always exactly 42 days (6 weeks) after
 * `startOfMonthGrid`, minus 1ms. This gives a stable 6-row grid
 * regardless of how the month aligns, which keeps the layout
 * height from jumping between months.
 */
export function endOfMonthGrid(date: Date): Date {
  const start = startOfMonthGrid(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 42);
  end.setMilliseconds(-1);
  return end;
}

/** Add N days to the given date, returning a fresh Date. */
export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Add N months to the given date, returning a fresh Date. */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** True if two dates fall on the same calendar day in local time. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** True if the given date's month/year matches the reference. */
export function isSameMonth(date: Date, reference: Date): boolean {
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth()
  );
}

/**
 * Format a date range header for the nav bar — "April 2026" for
 * the month view, "Apr 6 – 12, 2026" for the week view.
 */
export function formatMonthHeader(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatWeekHeader(date: Date): string {
  const start = startOfWeek(date);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    const month = start.toLocaleDateString(undefined, { month: 'short' });
    return `${month} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (sameYear) {
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * Build a 42-element flat array of the dates that should appear in
 * a month grid. The first element is `startOfMonthGrid(anchor)`,
 * each subsequent element is one day later. Consumers typically
 * `chunk(dates, 7)` this into 6 week-rows.
 */
export function monthGridDates(anchor: Date): Date[] {
  const start = startOfMonthGrid(anchor);
  const out: Date[] = [];
  for (let i = 0; i < 42; i++) {
    out.push(addDays(start, i));
  }
  return out;
}

/**
 * Build a 7-element flat array of dates for the week containing
 * the anchor. Element 0 is Sunday.
 */
export function weekDates(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  const out: Date[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(addDays(start, i));
  }
  return out;
}
