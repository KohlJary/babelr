// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo, useState, type ReactNode } from 'react';

export interface ScrollListViewProps<T> {
  items: T[];
  getId: (item: T) => string;
  getSearchText?: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Header title. */
  title?: string;
  onClose?: () => void;
  /** Search placeholder. Omit to hide the search bar. */
  searchPlaceholder?: string;
  emptyMessage?: string;
  loading?: boolean;
  /** Load-more callback for paginated lists. */
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export function ScrollListView<T>({
  items,
  getId,
  getSearchText,
  renderItem,
  title,
  onClose,
  searchPlaceholder,
  emptyMessage,
  loading,
  hasMore,
  onLoadMore,
}: ScrollListViewProps<T>) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim() || !getSearchText) return items;
    const q = query.toLowerCase();
    return items.filter((item) => getSearchText(item).toLowerCase().includes(q));
  }, [items, query, getSearchText]);

  return (
    <div className="scroll-list-view">
      <header className="scroll-list-header">
        {title && <h2 className="scroll-list-title">{title}</h2>}
        {onClose && (
          <button
            type="button"
            className="scroll-list-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        )}
      </header>
      {searchPlaceholder && (
        <div className="scroll-list-search">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
          />
        </div>
      )}
      <div className="scroll-list-body">
        {loading && items.length === 0 && (
          <div className="scroll-list-loading">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="scroll-list-empty">
            {emptyMessage ?? 'Nothing here yet.'}
          </div>
        )}
        {filtered.map((item) => (
          <div key={getId(item)} className="scroll-list-item">
            {renderItem(item)}
          </div>
        ))}
        {hasMore && onLoadMore && (
          <button
            type="button"
            className="scroll-list-load-more"
            onClick={onLoadMore}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
