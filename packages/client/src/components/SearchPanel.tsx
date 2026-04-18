// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { MessageListResponse } from '@babelr/shared';
import * as api from '../api';
import { MessageItem } from './MessageItem';
import { useT } from '../i18n/I18nProvider';

interface SearchFilters {
  text?: string;
  from?: string;
  channel?: string;
  before?: string;
  after?: string;
  has?: string[];
}

interface SearchPanelProps {
  channelId?: string;
  onClose: () => void;
}

export function SearchPanel({ channelId, onClose }: SearchPanelProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageListResponse | null>(null);
  const [filters, setFilters] = useState<SearchFilters | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const res = await api.searchMessages(query.trim(), channelId);
      setResults(res);
      setFilters((res as unknown as Record<string, unknown>).filters as SearchFilters ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('search.failed'));
    } finally {
      setLoading(false);
    }
  };

  const removeFilter = (key: string) => {
    // Rebuild query without the filter
    const tokens = query.split(/\s+/).filter((tok) => {
      const lower = tok.toLowerCase();
      if (key === 'from' && lower.startsWith('from:')) return false;
      if (key === 'channel' && lower.startsWith('in:')) return false;
      if (key === 'before' && lower.startsWith('before:')) return false;
      if (key === 'after' && lower.startsWith('after:')) return false;
      if (key.startsWith('has:') && lower === key) return false;
      return true;
    });
    setQuery(tokens.join(' '));
  };

  return (
    <div className="search-panel-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-header">
          <form onSubmit={(e) => void handleSearch(e)} className="search-form">
            <input
              type="text"
              className="search-input"
              placeholder={t('search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button type="submit" className="search-btn">
              {t('search.button')}
            </button>
          </form>
          <button className="search-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {filters && (
          <div className="search-filters">
            {filters.from && (
              <span className="search-filter-pill">
                from:{filters.from}
                <button onClick={() => removeFilter('from')}>&times;</button>
              </span>
            )}
            {filters.channel && (
              <span className="search-filter-pill">
                in:{filters.channel}
                <button onClick={() => removeFilter('channel')}>&times;</button>
              </span>
            )}
            {filters.before && (
              <span className="search-filter-pill">
                before:{filters.before.slice(0, 10)}
                <button onClick={() => removeFilter('before')}>&times;</button>
              </span>
            )}
            {filters.after && (
              <span className="search-filter-pill">
                after:{filters.after.slice(0, 10)}
                <button onClick={() => removeFilter('after')}>&times;</button>
              </span>
            )}
            {filters.has?.map((h) => (
              <span key={h} className="search-filter-pill">
                has:{h}
                <button onClick={() => removeFilter(`has:${h}`)}>&times;</button>
              </span>
            ))}
          </div>
        )}

        <div className="search-hint">
          {t('search.hint')}
        </div>

        <div className="search-content">
          {loading && <div className="search-loading">{t('common.loading')}</div>}
          {error && <div className="search-error">{error}</div>}
          {results && results.messages.length === 0 && !loading && (
            <div className="search-empty">{t('search.noResults')}</div>
          )}
          {results && results.messages.length > 0 && (
            <div className="search-results">
              {results.messages.map((item) => (
                <MessageItem
                  key={item.message.id}
                  data={item}
                  compact={false}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
