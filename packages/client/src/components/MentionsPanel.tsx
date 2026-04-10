// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import * as api from '../api';
import { renderMarkdown } from '../utils/markdown';
import { useT } from '../i18n/I18nProvider';

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
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <div className="settings-header">
          <h2>{t('mentions.title')}</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        {loading && <div className="sidebar-empty">{t('common.loading')}</div>}
        {!loading && mentions.length === 0 && <div className="sidebar-empty">{t('mentions.empty')}</div>}

        {mentions.map((item) => (
          <div key={item.message.id} className="mention-item">
            <div className="mention-header">
              <span className="mention-author">{item.author.displayName ?? item.author.preferredUsername}</span>
              <span className="mention-time">{formatDate(item.message.published)}</span>
            </div>
            <div className="mention-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.message.content) }} />
          </div>
        ))}
      </div>
    </div>
  );
}
