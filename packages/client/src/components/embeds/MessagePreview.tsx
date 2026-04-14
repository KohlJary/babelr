// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { MessageEmbedView } from '@babelr/shared';
import * as api from '../../api';
import { useT } from '../../i18n/I18nProvider';

interface MessagePreviewProps {
  slug: string;
  serverSlug?: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; embed: MessageEmbedView }
  | { status: 'locked' };

export function MessagePreview({ slug, serverSlug }: MessagePreviewProps) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getMessageBySlug(slug, serverSlug)
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
  const author = embed.author.displayName ?? embed.author.preferredUsername;
  return (
    <div className="message-preview">
      <div className="message-preview-meta">
        <strong>{author}</strong>
        {embed.channelName && <span className="message-preview-channel">#{embed.channelName}</span>}
        {embed.serverName && <span className="message-preview-server">{embed.serverName}</span>}
      </div>
      <div className="message-preview-time">
        {new Date(embed.published).toLocaleString()}
      </div>
      <div className="message-preview-body">{embed.content}</div>
    </div>
  );
}
