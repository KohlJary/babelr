// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { FileEmbedView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface ImageEmbedProps {
  slug: string;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'ok'; data: FileEmbedView }
  | { status: 'locked' };

const resolved = new Map<string, EmbedState>();
const inflight = new Map<string, Promise<EmbedState>>();

function fetchEmbed(slug: string): Promise<EmbedState> {
  const cached = resolved.get(slug);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(slug);
  if (existing) return existing;

  const promise = api
    .getFileBySlug(slug)
    .then<EmbedState>((data) => {
      const next: EmbedState = { status: 'ok', data };
      resolved.set(slug, next);
      inflight.delete(slug);
      return next;
    })
    .catch<EmbedState>(() => {
      const next: EmbedState = { status: 'locked' };
      resolved.set(slug, next);
      inflight.delete(slug);
      return next;
    });

  inflight.set(slug, promise);
  return promise;
}

export function ImageEmbed({ slug }: ImageEmbedProps) {
  const t = useT();
  const [state, setState] = useState<EmbedState>(
    () => resolved.get(slug) ?? { status: 'loading' },
  );
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    if (state.status !== 'loading') return;
    let cancelled = false;
    void fetchEmbed(slug).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [slug, state.status]);

  const closeLightbox = useCallback(() => setLightbox(false), []);

  if (state.status === 'loading') {
    return <span className="image-embed loading">{t('common.loading')}</span>;
  }

  if (state.status === 'locked') {
    return <span className="image-embed locked">{t('files.embedLocked')}</span>;
  }

  const { data } = state;

  return (
    <>
      <figure className="image-embed ok" onClick={() => setLightbox(true)}>
        <img
          src={data.storageUrl}
          alt={data.title ?? data.filename}
          className="image-embed-img"
          loading="lazy"
        />
        {data.title && data.title !== data.filename && (
          <figcaption className="image-embed-caption">{data.title}</figcaption>
        )}
      </figure>

      {lightbox && (
        <div className="image-lightbox-overlay" onClick={closeLightbox}>
          <div className="image-lightbox" onClick={(e) => e.stopPropagation()}>
            <div className="image-lightbox-main">
              <img
                src={data.storageUrl}
                alt={data.title ?? data.filename}
                className="image-lightbox-img"
              />
            </div>
            <aside className="image-lightbox-sidebar">
              <div className="image-lightbox-header">
                <h3>{data.title ?? data.filename}</h3>
                <button className="settings-close" onClick={closeLightbox}>
                  &times;
                </button>
              </div>
              {data.description && (
                <p className="image-lightbox-description">{data.description}</p>
              )}
              <p className="file-meta">
                {data.uploader.displayName ?? data.uploader.preferredUsername}
                {data.serverName && <> &middot; {data.serverName}</>}
              </p>
              <a
                href={data.storageUrl}
                download
                className="friends-btn accept"
                style={{ alignSelf: 'flex-start' }}
              >
                {t('files.download')}
              </a>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}
