// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { AuditLogEntry } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface AuditLogPanelProps {
  serverId: string;
  onClose: () => void;
}

const CATEGORIES = ['server', 'channel', 'role', 'member', 'wiki', 'event', 'file'] as const;

export function AuditLogPanel({ serverId, onClose }: AuditLogPanelProps) {
  const t = useT();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [category, setCategory] = useState<string | undefined>();

  const load = useCallback(
    async (cat?: string, cur?: string) => {
      setLoading(true);
      try {
        const res = await api.getAuditLog(serverId, cat, cur);
        if (cur) {
          setEntries((prev) => [...prev, ...res.entries]);
        } else {
          setEntries(res.entries);
        }
        setHasMore(res.hasMore);
        setCursor(res.cursor);
      } catch {
        // Permission denied or server error
      } finally {
        setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    void load(category);
  }, [load, category]);

  const handleCategoryChange = (cat: string | undefined) => {
    setCategory(cat);
    setEntries([]);
    setCursor(undefined);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal audit-log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('audit.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="audit-log-filters">
          <button
            className={`audit-cat-btn ${!category ? 'active' : ''}`}
            onClick={() => handleCategoryChange(undefined)}
          >
            {t('audit.allCategories')}
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`audit-cat-btn ${category === cat ? 'active' : ''}`}
              onClick={() => handleCategoryChange(cat)}
            >
              {t(`audit.category.${cat}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>

        <div className="audit-log-list">
          {entries.length === 0 && !loading && (
            <div className="sidebar-empty">{t('audit.noEntries')}</div>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="audit-log-entry">
              <div className="audit-log-entry-header">
                <span className="audit-log-actor">{entry.actorName}</span>
                <span className="audit-log-action">{entry.action}</span>
                <span className="audit-log-time">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="audit-log-summary">{entry.summary}</div>
            </div>
          ))}
          {loading && <div className="sidebar-empty">{t('common.loading')}</div>}
          {hasMore && !loading && (
            <button
              className="voice-control-btn audit-load-more"
              onClick={() => void load(category, cursor)}
            >
              {t('audit.loadMore')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
