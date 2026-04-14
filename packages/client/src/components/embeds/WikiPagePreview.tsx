// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { WikiPageView } from '@babelr/shared';
import * as api from '../../api';
import { renderWikiMarkdown } from '../../utils/markdown';
import { useT } from '../../i18n/I18nProvider';

interface WikiPagePreviewProps {
  /** Wiki page slug. */
  slug: string;
  /** Server id to fetch the page from. For the manual kind, this is
   *  the manual server's id (resolved by the caller). */
  serverId: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; page: WikiPageView }
  | { status: 'locked' };

export function WikiPagePreview({ slug, serverId }: WikiPagePreviewProps) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getWikiPage(serverId, slug)
      .then((res) => {
        if (!cancelled) setState({ status: 'ok', page: res.page });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'locked' });
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, slug]);

  if (state.status === 'loading') {
    return <div className="embed-preview-loading">{t('messages.embedLoading')}</div>;
  }
  if (state.status === 'locked') {
    return <div className="embed-preview-locked">{t('messages.lockedEmbed')}</div>;
  }

  const { page } = state;
  return (
    <div className="wiki-page-preview">
      <h3 className="wiki-page-preview-title">{page.title}</h3>
      {page.tags.length > 0 && (
        <div className="wiki-page-preview-tags">
          {page.tags.map((tag) => (
            <span key={tag} className="wiki-page-preview-tag">{tag}</span>
          ))}
        </div>
      )}
      <div
        className="wiki-page-preview-body markdown-body"
        dangerouslySetInnerHTML={{ __html: renderWikiMarkdown(page.content) }}
      />
    </div>
  );
}
