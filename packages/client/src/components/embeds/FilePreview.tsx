// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { FileEmbedView } from '@babelr/shared';
import * as api from '../../api';
import { useT } from '../../i18n/I18nProvider';

interface FilePreviewProps {
  slug: string;
  serverSlug?: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; embed: FileEmbedView }
  | { status: 'locked' };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function FilePreview({ slug, serverSlug }: FilePreviewProps) {
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
  const isImage = embed.contentType.startsWith('image/');
  return (
    <div className="file-preview">
      {isImage && (
        <img
          src={embed.storageUrl}
          alt={embed.title ?? embed.filename}
          className="file-preview-image"
        />
      )}
      <h3 className="file-preview-title">{embed.title ?? embed.filename}</h3>
      <div className="file-preview-meta">
        <span>{embed.contentType}</span>
        <span>{formatBytes(embed.sizeBytes)}</span>
        <span>by {embed.uploader.displayName ?? embed.uploader.preferredUsername}</span>
      </div>
      {embed.description && (
        <div className="file-preview-description">{embed.description}</div>
      )}
      <a
        className="file-preview-download"
        href={embed.storageUrl}
        target="_blank"
        rel="noreferrer"
      >
        ⬇ Download
      </a>
    </div>
  );
}
