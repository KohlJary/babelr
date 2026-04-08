// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { MessageListResponse } from '@babelr/shared';
import * as api from '../api';
import { MessageItem } from './MessageItem';

interface SearchPanelProps {
  channelId?: string;
  onClose: () => void;
}

export function SearchPanel({ channelId, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageListResponse | null>(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="search-panel-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-header">
          <form onSubmit={handleSearch} className="search-form">
            <input
              type="text"
              className="search-input"
              placeholder="Search messages..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button type="submit" className="search-btn">
              Search
            </button>
          </form>
          <button className="search-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="search-content">
          {loading && <div className="search-loading">Searching...</div>}
          {error && <div className="search-error">{error}</div>}
          {results && results.messages.length === 0 && !loading && (
            <div className="search-empty">No results found</div>
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
