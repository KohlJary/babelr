// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useMemo } from 'react';
import { useT } from '../i18n/I18nProvider';
import * as api from '../api';
import type { FileEmbedView, FileView } from '@babelr/shared';
import { useFileTranslation } from '../hooks/useFileTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';

const resolved = new Map<string, FileEmbedView>();
const inflight = new Map<string, Promise<FileEmbedView>>();

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileIcon(contentType?: string): string {
  if (!contentType) return '\u{1F4CE}';
  if (contentType.startsWith('image/')) return '\u{1F5BC}\uFE0F';
  if (contentType.includes('zip') || contentType.includes('tar') || contentType.includes('gzip'))
    return '\u{1F4E6}';
  if (contentType.includes('pdf') || contentType.includes('document') || contentType.includes('text'))
    return '\u{1F4C4}';
  return '\u{1F4CE}';
}

interface FileEmbedProps {
  slug: string;
  onNavigate?: (embed: FileEmbedView) => void;
}

export default function FileEmbed({ slug, onNavigate }: FileEmbedProps) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'ok' | 'locked'>('loading');
  const [data, setData] = useState<FileEmbedView | null>(null);

  useEffect(() => {
    if (resolved.has(slug)) {
      setData(resolved.get(slug)!);
      setState('ok');
      return;
    }

    let cancelled = false;

    let promise = inflight.get(slug);
    if (!promise) {
      promise = api.getFileBySlug(slug);
      inflight.set(slug, promise);
    }

    promise
      .then((embed) => {
        resolved.set(slug, embed);
        inflight.delete(slug);
        if (!cancelled) {
          setData(embed);
          setState('ok');
        }
      })
      .catch(() => {
        inflight.delete(slug);
        if (!cancelled) setState('locked');
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Translate the embed's description through the same pipeline as
  // FilesPanel. The FileEmbedView → FileView cast is minimal — the
  // hook only reads id and description.
  const { settings: translationSettings } = useTranslationSettings();
  const translationSource = useMemo<FileView[]>(() => {
    if (!data) return [];
    return [{ id: data.id, description: data.description } as FileView];
  }, [data]);
  const { translations: fileTranslations } = useFileTranslation(
    translationSource,
    [],
    translationSettings,
  );

  if (state === 'loading') {
    return (
      <div className="file-embed loading">
        <em>{t('files.embedLoading')}</em>
      </div>
    );
  }

  if (state === 'locked' || !data) {
    return (
      <div className="file-embed locked">
        <em>{t('files.embedLocked')}</em>
      </div>
    );
  }

  const trans = fileTranslations.get(data.id);
  const rawDesc = trans?.description ?? data.description;
  const description =
    rawDesc && rawDesc.length > 120 ? rawDesc.slice(0, 120) + '\u2026' : rawDesc;
  const isImage = data.contentType.startsWith('image/');

  return (
    <div className="file-embed ok">
      <button className="file-embed-body" onClick={() => onNavigate?.(data)}>
        {isImage ? (
          <img
            src={data.storageUrl}
            alt={data.filename}
            className="file-embed-thumbnail"
          />
        ) : (
          <span className="file-embed-icon">{fileIcon(data.contentType)}</span>
        )}
        <div className="file-embed-content">
          <span className="file-embed-filename">{data.filename}</span>
          <span className="file-embed-size">{formatSize(data.sizeBytes)}</span>
          {description && (
            <span className="file-embed-description">{description}</span>
          )}
        </div>
      </button>
      <a
        className="file-embed-download"
        href={data.storageUrl}
        download
        onClick={(e) => e.stopPropagation()}
      >
        {t('files.download')}
      </a>
    </div>
  );
}
