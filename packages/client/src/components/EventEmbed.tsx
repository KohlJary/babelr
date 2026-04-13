// SPDX-License-Identifier: Hippocratic-3.0
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventEmbedView, EventRsvpStatus, EventView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { useEventTranslation } from '../hooks/useEventTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';

/**
 * Inline invite card for a referenced calendar event. Rendered
 * anywhere a `[[event:slug]]` ref appears — inside a wiki page or
 * inside a chat message. The shape mirrors `MessageEmbed`, but the
 * embed is interactive: a reader can RSVP "going" / "interested" /
 * "declined" directly from the card without opening the full event
 * panel, which is the main motivation for this feature (e.g. a
 * weekly meeting series embedded on a wiki page where people join
 * the invite list in one click).
 *
 * Module-level cache dedupes concurrent fetches of the same slug so
 * a wiki page with multiple references to the same event fires
 * exactly one network call. After an RSVP, the cache entry is
 * replaced in place so every other mounted embed of the same slug
 * re-renders with fresh counts.
 */

interface EventEmbedProps {
  slug: string;
  /** Server slug for cross-server same-tower refs. */
  serverSlug?: string;
  /** Called when the user clicks the card body to navigate to the event. */
  onNavigate?: (embed: EventEmbedView) => void;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'ok'; embed: EventEmbedView }
  | { status: 'locked' };

const resolved = new Map<string, EmbedState>();
const inflight = new Map<string, Promise<EmbedState>>();
// Subscribers are notified when a slug's cache entry changes, so
// every mounted instance of `<EventEmbed slug={x}>` updates in sync
// after one of them posts an RSVP.
const listeners = new Map<string, Set<(s: EmbedState) => void>>();

function subscribe(slug: string, fn: (s: EmbedState) => void): () => void {
  let set = listeners.get(slug);
  if (!set) {
    set = new Set();
    listeners.set(slug, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(slug);
  };
}

function publish(slug: string, next: EmbedState): void {
  resolved.set(slug, next);
  const set = listeners.get(slug);
  if (!set) return;
  for (const fn of set) fn(next);
}

function fetchEmbed(slug: string, serverSlug?: string): Promise<EmbedState> {
  const cacheKey = serverSlug ? `${serverSlug}:${slug}` : slug;
  const cached = resolved.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = api
    .getEventBySlug(slug, serverSlug)
    .then<EmbedState>((embed) => {
      const next: EmbedState = { status: 'ok', embed };
      publish(cacheKey, next);
      inflight.delete(cacheKey);
      return next;
    })
    .catch<EmbedState>(() => {
      const next: EmbedState = { status: 'locked' };
      publish(cacheKey, next);
      inflight.delete(cacheKey);
      return next;
    });

  inflight.set(cacheKey, promise);
  return promise;
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const dateFmt: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };
  const timeFmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const startStr = `${start.toLocaleDateString(undefined, dateFmt)} ${start.toLocaleTimeString(undefined, timeFmt)}`;
  if (sameDay) {
    return `${startStr} – ${end.toLocaleTimeString(undefined, timeFmt)}`;
  }
  return `${startStr} – ${end.toLocaleDateString(undefined, dateFmt)} ${end.toLocaleTimeString(undefined, timeFmt)}`;
}

export function EventEmbed({ slug, serverSlug, onNavigate }: EventEmbedProps) {
  const t = useT();
  const cacheKey = serverSlug ? `${serverSlug}:${slug}` : slug;
  const [state, setState] = useState<EmbedState>(
    () => resolved.get(cacheKey) ?? { status: 'loading' },
  );
  const [rsvping, setRsvping] = useState(false);

  // Run the embed's title + description through the same tone-
  // preserving pipeline used by EventsPanel / EventDetailPanel. We
  // synthesize a minimal `EventView`-shaped wrapper (the hook only
  // reads id/title/description) so the hash-keyed cache is shared
  // across the panel and the embed — a wiki page that references
  // the same event the user just viewed in the calendar will hit
  // the cache on first render.
  const { settings: translationSettings } = useTranslationSettings();
  const translationSource = useMemo<EventView[]>(() => {
    if (state.status !== 'ok') return [];
    const { embed } = state;
    return [
      {
        id: embed.id,
        title: embed.title,
        description: embed.description,
      } as EventView,
    ];
  }, [state]);
  const { translations: eventFieldTranslations } = useEventTranslation(
    translationSource,
    translationSettings,
  );

  useEffect(() => {
    let cancelled = false;
    const unsub = subscribe(cacheKey, (next) => {
      if (!cancelled) setState(next);
    });
    if (state.status === 'loading') {
      void fetchEmbed(slug, serverSlug).then((next) => {
        if (!cancelled) setState(next);
      });
    }
    return () => {
      cancelled = true;
      unsub();
    };
  }, [slug]);

  const onRsvp = useCallback(
    async (status: EventRsvpStatus) => {
      if (rsvping) return;
      setRsvping(true);
      try {
        const next = await api.rsvpEventBySlug(slug, status);
        publish(slug, { status: 'ok', embed: next });
      } catch {
        // Silent failure — leave current state in place. A future
        // iteration could surface a toast.
      } finally {
        setRsvping(false);
      }
    },
    [slug, rsvping],
  );

  if (state.status === 'loading') {
    return (
      <span className="event-embed loading" data-event-slug={slug}>
        {t('events.embedLoading')}
      </span>
    );
  }

  if (state.status === 'locked') {
    return (
      <span className="event-embed locked" data-event-slug={slug}>
        {t('events.embedLocked')}
      </span>
    );
  }

  const { embed } = state;
  const trans = eventFieldTranslations.get(embed.id);
  const displayTitle = trans?.title ?? embed.title;
  const displayDescription = trans?.description ?? embed.description;
  void displayDescription; // description not shown in the compact card; translation still warms the shared cache for the panel

  return (
    <div className="event-embed ok" data-event-slug={slug}>
      <button
        type="button"
        className="event-embed-body"
        onClick={() => onNavigate?.(embed)}
        title={t('events.embedGoToEvent')}
      >
        <span className="event-embed-icon">📅</span>
        <span className="event-embed-content">
          <span className="event-embed-title">{displayTitle}</span>
          <span className="event-embed-when">{formatRange(embed.startAt, embed.endAt)}</span>
          {embed.location && (
            <span className="event-embed-location">📍 {embed.location}</span>
          )}
          <span className="event-embed-counts">
            {t('events.embedCountsGoing', { count: String(embed.counts.going) })}
            {embed.counts.interested > 0 && (
              <>
                {' · '}
                {t('events.embedCountsInterested', { count: String(embed.counts.interested) })}
              </>
            )}
          </span>
        </span>
      </button>
      <div className="event-embed-actions">
        <button
          type="button"
          className={`event-embed-rsvp${embed.myRsvp === 'going' ? ' active' : ''}`}
          onClick={() => onRsvp('going')}
          disabled={rsvping}
        >
          {t('events.rsvpGoing')}
        </button>
        <button
          type="button"
          className={`event-embed-rsvp${embed.myRsvp === 'interested' ? ' active' : ''}`}
          onClick={() => onRsvp('interested')}
          disabled={rsvping}
        >
          {t('events.rsvpInterested')}
        </button>
        <button
          type="button"
          className={`event-embed-rsvp${embed.myRsvp === 'declined' ? ' active' : ''}`}
          onClick={() => onRsvp('declined')}
          disabled={rsvping}
        >
          {t('events.rsvpDeclined')}
        </button>
      </div>
    </div>
  );
}
