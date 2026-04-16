// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import * as api from '../api';
import { renderMarkdown } from '../utils/markdown';
import { useT } from '../i18n/I18nProvider';
import { ScrollListView } from './ScrollListView';

interface MentionsPanelProps {
  onClose: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function MentionsPanel({ onClose }: MentionsPanelProps) {
  const t = useT();
  const [mentions, setMentions] = useState<MessageWithAuthor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMentions().then((res) => setMentions(res.messages)).finally(() => setLoading(false));
  }, []);

  return (
    <ScrollListView<MessageWithAuthor>
      title={t('mentions.title')}
      items={mentions}
      getId={(item) => item.message.id}
      renderItem={(item) => (
        <div className="mention-item">
          <div className="mention-header">
            <span className="mention-author">{item.author.displayName ?? item.author.preferredUsername}</span>
            <span className="mention-time">{formatDate(item.message.published)}</span>
          </div>
          <div className="mention-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.message.content) }} />
        </div>
      )}
      onClose={onClose}
      emptyMessage={t('mentions.empty')}
      loading={loading}
    />
  );
}
