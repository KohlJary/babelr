// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { FileEmbedView } from '@babelr/shared';
import * as api from '../../api';
import { useT } from '../../i18n/I18nProvider';

interface ImagePreviewProps {
  slug: string;
  serverSlug?: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; embed: FileEmbedView }
  | { status: 'locked' };

/**
 * Image-focused preview — the image fills the available space; metadata
 * is compact below it. Click the image to open it in a new tab for
 * fullscreen viewing.
 */
export function ImagePreview({ slug, serverSlug }: ImagePreviewProps) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getFileBySlug(slug, serverSlug)
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
    <div className="image-preview">
      <a href={embed.storageUrl} target="_blank" rel="noreferrer" title="Open fullscreen">
        <img
          src={embed.storageUrl}
          alt={embed.title ?? embed.filename}
          className="image-preview-image"
        />
      </a>
      <div className="image-preview-meta">
        <span className="image-preview-name">{embed.title ?? embed.filename}</span>
        <span className="image-preview-uploader">
          by {embed.uploader.displayName ?? embed.uploader.preferredUsername}
        </span>
      </div>
      {embed.description && (
        <div className="image-preview-description">{embed.description}</div>
      )}
    </div>
  );
}
