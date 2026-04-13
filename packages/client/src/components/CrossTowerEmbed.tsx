// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { WikiRefKind, WikiRefOrigin } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface CrossTowerEmbedProps {
  kind: WikiRefKind;
  slug: string;
  origin: WikiRefOrigin;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'locked' };

// Module-level cache keyed by "server@tower:kind:slug"
const resolved = new Map<string, EmbedState>();
const inflight = new Map<string, Promise<EmbedState>>();

function cacheKey(origin: WikiRefOrigin, kind: string, slug: string): string {
  return `${origin.server}@${origin.tower}:${kind}:${slug}`;
}

function kindIcon(kind: WikiRefKind): string {
  switch (kind) {
    case 'message': return '\u{1F4AC}';
    case 'event': return '\u{1F4C5}';
    case 'file': return '\u{1F4CE}';
    case 'page': return '\u{1F4C4}';
    default: return '\u{1F517}';
  }
}

function kindLabel(kind: WikiRefKind): string {
  switch (kind) {
    case 'message': return 'Message';
    case 'event': return 'Event';
    case 'file': return 'File';
    case 'page': return 'Wiki page';
    default: return 'Content';
  }
}

export function CrossTowerEmbed({ kind, slug, origin }: CrossTowerEmbedProps) {
  const t = useT();
  const key = cacheKey(origin, kind, slug);
  const [state, setState] = useState<EmbedState>(
    () => resolved.get(key) ?? { status: 'loading' },
  );

  useEffect(() => {
    if (state.status !== 'loading') return;
    let cancelled = false;

    let promise = inflight.get(key);
    if (!promise) {
      promise = api
        .resolveEmbed(origin.server, origin.tower, kind, slug)
        .then<EmbedState>((data) => {
          const next: EmbedState = { status: 'ok', data };
          resolved.set(key, next);
          inflight.delete(key);
          return next;
        })
        .catch<EmbedState>(() => {
          const next: EmbedState = { status: 'locked' };
          resolved.set(key, next);
          inflight.delete(key);
          return next;
        });
      inflight.set(key, promise);
    }

    void promise.then((next) => {
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [key, state.status, kind, slug, origin]);

  if (state.status === 'loading') {
    return (
      <span className="cross-tower-embed loading">
        {t('common.loading')}
      </span>
    );
  }

  if (state.status === 'locked') {
    return (
      <span className="cross-tower-embed locked">
        {kindIcon(kind)} {kindLabel(kind)} unavailable on {origin.tower}
      </span>
    );
  }

  const { data } = state;
  const title = (data.title as string) ?? (data.name as string) ?? (data.filename as string) ?? slug;
  const snippet = (data.content as string)?.slice(0, 150) ??
    (data.description as string)?.slice(0, 150) ?? '';

  return (
    <div className="cross-tower-embed ok">
      <div className="cross-tower-embed-body">
        <span className="cross-tower-embed-icon">{kindIcon(kind)}</span>
        <div className="cross-tower-embed-content">
          <span className="cross-tower-embed-title">{title}</span>
          {snippet && (
            <span className="cross-tower-embed-snippet">{snippet}</span>
          )}
          <span className="cross-tower-embed-origin">
            {origin.server}@{origin.tower}
          </span>
        </div>
      </div>
    </div>
  );
}
