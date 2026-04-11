// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { MessageEmbedView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

/**
 * Inline preview of a referenced message. Rendered anywhere a
 * `[[msg:slug]]` appears — inside a wiki page or inside another
 * chat message.
 *
 * Fetches the referenced message by slug on mount. Module-level
 * cache dedupes concurrent/duplicate fetches so a wiki page with
 * three embeds of the same message fires exactly one network call.
 * The cache persists for the life of the tab; if the referenced
 * message is edited, the embed won't see the update until a full
 * reload — acceptable for a v1 and avoids a whole invalidation
 * story we don't need yet.
 *
 * Three render states:
 *   - **loading** — initial fetch in flight
 *   - **ok** — got the message, render the preview
 *   - **locked** — 404 from the server, meaning either the message
 *     doesn't exist or the caller can't access it. The server
 *     deliberately doesn't distinguish the two cases to avoid
 *     leaking existence.
 */

interface MessageEmbedProps {
  slug: string;
  /** Called when the user clicks the embed to navigate to the message. */
  onNavigate?: (embed: MessageEmbedView) => void;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'ok'; embed: MessageEmbedView }
  | { status: 'locked' };

// Module-level caches. `resolved` holds successful fetches; `inflight`
// holds in-progress promises keyed by slug so duplicate requests
// dedupe onto the same pending fetch.
const resolved = new Map<string, EmbedState>();
const inflight = new Map<string, Promise<EmbedState>>();

function fetchEmbed(slug: string): Promise<EmbedState> {
  const cached = resolved.get(slug);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(slug);
  if (existing) return existing;

  const promise = api
    .getMessageBySlug(slug)
    .then<EmbedState>((embed) => {
      const next: EmbedState = { status: 'ok', embed };
      resolved.set(slug, next);
      inflight.delete(slug);
      return next;
    })
    .catch<EmbedState>(() => {
      // Any error — 404, 400, network — surfaces as 'locked' to the
      // user. The backend intentionally returns 404 for both
      // not-found and no-access cases.
      const next: EmbedState = { status: 'locked' };
      resolved.set(slug, next);
      inflight.delete(slug);
      return next;
    });

  inflight.set(slug, promise);
  return promise;
}

export function MessageEmbed({ slug, onNavigate }: MessageEmbedProps) {
  const t = useT();
  const [state, setState] = useState<EmbedState>(() => resolved.get(slug) ?? { status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (state.status !== 'loading') return;
    void fetchEmbed(slug).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // Only `slug` drives refetches — `state.status` transitioning
    // from loading to ok/locked inside this effect would trigger a
    // no-op re-run if it were a dep. The cache hit in the useState
    // initializer handles the slug-change case correctly.
  }, [slug]);

  if (state.status === 'loading') {
    return (
      <span className="message-embed loading" data-msg-slug={slug}>
        {t('messages.embedLoading')}
      </span>
    );
  }

  if (state.status === 'locked') {
    return (
      <span className="message-embed locked" data-msg-slug={slug}>
        {t('messages.lockedEmbed')}
      </span>
    );
  }

  const { embed } = state;
  const authorName = embed.author.displayName ?? embed.author.preferredUsername;
  const snippet = embed.content.length > 200
    ? embed.content.slice(0, 200) + '…'
    : embed.content;

  return (
    <button
      type="button"
      className="message-embed ok"
      onClick={() => onNavigate?.(embed)}
      title={t('messages.goToMessage')}
      data-msg-slug={slug}
    >
      <span className="message-embed-icon">💬</span>
      <span className="message-embed-body">
        <span className="message-embed-meta">
          <strong>{authorName}</strong>
          {embed.channelName && (
            <>
              {' '}
              · #<span>{embed.channelName}</span>
            </>
          )}
          {embed.serverName && (
            <>
              {' '}
              · <span className="message-embed-server">{embed.serverName}</span>
            </>
          )}
        </span>
        <span className="message-embed-snippet">{snippet || <em>(empty message)</em>}</span>
      </span>
    </button>
  );
}
