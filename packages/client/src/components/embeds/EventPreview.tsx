// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { EventEmbedView } from '@babelr/shared';
import * as api from '../../api';
import { useT } from '../../i18n/I18nProvider';

interface EventPreviewProps {
  slug: string;
  serverSlug?: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; embed: EventEmbedView }
  | { status: 'locked' };

function fmtRange(startAt: string, endAt: string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (s.toDateString() === e.toDateString()) {
    return `${s.toLocaleString()} – ${e.toLocaleTimeString()}`;
  }
  return `${s.toLocaleString()} – ${e.toLocaleString()}`;
}

export function EventPreview({ slug, serverSlug }: EventPreviewProps) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getEventBySlug(slug, serverSlug)
      .then((embed) => {
        if (!cancelled) setState({ status: 'ok', embed });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'locked' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, serverSlug]);

  if (state.status === 'loading') {
    return <div className="embed-preview-loading">{t('messages.embedLoading')}</div>;
  }
  if (state.status === 'locked') {
    return <div className="embed-preview-locked">{t('messages.lockedEmbed')}</div>;
  }

  const { embed } = state;
  return (
    <div className="event-preview">
      <h3 className="event-preview-title">{embed.title}</h3>
      <div className="event-preview-when">{fmtRange(embed.startAt, embed.endAt)}</div>
      {embed.location && <div className="event-preview-location">📍 {embed.location}</div>}
      {embed.description && (
        <div className="event-preview-description">{embed.description}</div>
      )}
      <div className="event-preview-counts">
        <span>✅ {embed.counts.going} going</span>
        <span>★ {embed.counts.interested} interested</span>
        <span>✗ {embed.counts.declined} declined</span>
      </div>
      {embed.myRsvp && (
        <div className="event-preview-myrsvp">Your RSVP: {embed.myRsvp}</div>
      )}
    </div>
  );
}
