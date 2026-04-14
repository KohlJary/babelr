// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { FileEmbedView, ActorProfile } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { useChat } from '../hooks/useChat';
import { useTranslation } from '../hooks/useTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';

interface ImageEmbedProps {
  slug: string;
  serverSlug?: string;
  actor?: ActorProfile;
  /** When provided, a click on the inline image fires this instead of
   *  opening the built-in lightbox. The embed registry uses this to
   *  open the image in the unified sidebar preview. */
  onClick?: () => void;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'ok'; data: FileEmbedView }
  | { status: 'locked' };

const resolved = new Map<string, EmbedState>();
const inflight = new Map<string, Promise<EmbedState>>();

function fetchEmbed(slug: string, serverSlug?: string): Promise<EmbedState> {
  const cacheKey = serverSlug ? `${serverSlug}:${slug}` : slug;
  const cached = resolved.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = api
    .getFileBySlug(slug, serverSlug)
    .then<EmbedState>((data) => {
      const next: EmbedState = { status: 'ok', data };
      resolved.set(cacheKey, next);
      inflight.delete(cacheKey);
      return next;
    })
    .catch<EmbedState>(() => {
      const next: EmbedState = { status: 'locked' };
      resolved.set(cacheKey, next);
      inflight.delete(cacheKey);
      return next;
    });

  inflight.set(cacheKey, promise);
  return promise;
}

export function ImageEmbed({ slug, serverSlug, actor, onClick }: ImageEmbedProps) {
  const t = useT();
  const cacheKey = serverSlug ? `${serverSlug}:${slug}` : slug;
  const [state, setState] = useState<EmbedState>(
    () => resolved.get(cacheKey) ?? { status: 'loading' },
  );
  const [lightbox, setLightbox] = useState(false);

  // Comment thread for the lightbox sidebar.
  const chatId = state.status === 'ok' ? state.data.chatId : null;
  const { settings: translationSettings } = useTranslationSettings();
  const {
    messages: chatMessages,
    loading: chatLoading,
    hasMore: chatHasMore,
    connected: chatConnected,
    sendMessage: chatSend,
    loadMore: chatLoadMore,
    typingUsers: chatTyping,
    notifyTyping: chatNotifyTyping,
  } = useChat(actor ?? { id: '', uri: '', preferredUsername: '', displayName: null, preferredLanguage: 'en' } as ActorProfile, chatId, false);
  const { translations: chatTranslations, isTranslating: chatIsTranslating } =
    useTranslation(chatMessages, translationSettings);

  useEffect(() => {
    if (state.status !== 'loading') return;
    let cancelled = false;
    void fetchEmbed(slug, serverSlug).then((next) => {
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
      <figure
        className="image-embed ok"
        onClick={() => (onClick ? onClick() : setLightbox(true))}
      >
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
              {actor && chatId && (
                <>
                  <div className="settings-divider" />
                  <h4>{t('files.comments')}</h4>
                  <div className="image-lightbox-chat">
                    <MessageList
                      messages={chatMessages}
                      loading={chatLoading}
                      hasMore={chatHasMore}
                      onLoadMore={chatLoadMore}
                      translations={chatTranslations}
                      isTranslating={chatIsTranslating}
                      actor={actor}
                    />
                    <TypingIndicator users={chatTyping} />
                    <MessageInput
                      onSend={chatSend}
                      disabled={!chatConnected}
                      onTyping={chatNotifyTyping}
                    />
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>
      )}
    </>
  );
}
