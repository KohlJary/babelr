// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import * as api from '../../api';
import { useT } from '../../i18n/I18nProvider';
import { WikiPagePreview } from './WikiPagePreview';

interface ManualPreviewProps {
  slug: string;
}

/**
 * Manual entries are wiki pages on a special seeded "babelr-manual"
 * server. We resolve that server's id once on mount, then defer to
 * the wiki preview renderer.
 */
export function ManualPreview({ slug }: ManualPreviewProps) {
  const t = useT();
  const [serverId, setServerId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getManualServerId()
      .then((res) => {
        if (!cancelled) setServerId(res.serverId);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="embed-preview-locked">{t('messages.lockedEmbed')}</div>;
  }
  if (!serverId) {
    return <div className="embed-preview-loading">{t('messages.embedLoading')}</div>;
  }
  return <WikiPagePreview slug={slug} serverId={serverId} />;
}
