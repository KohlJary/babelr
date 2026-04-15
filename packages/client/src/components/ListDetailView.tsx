// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo, useState, type ReactNode } from 'react';

/**
 * Generic list-detail layout: searchable left rail + main detail area.
 * Used by the WikiPanel-style surfaces across the app and exposed as a
 * plugin primitive so third-party plugin authors don't roll their own
 * for every new view.
 *
 * Sizing and styling match the existing wiki/files/events panels so
 * plugin surfaces feel native. The `renderItem` / `renderDetail` hooks
 * are fully arbitrary React — callers decide what a row and a detail
 * view look like. Defaults are provided for trivial cases (label-only
 * rows, empty detail placeholder).
 */
export interface ListDetailViewProps<T> {
  items: T[];
  /** Stable identity for each row. Used as the React key and for
   *  matching the current selection. */
  getId: (item: T) => string;
  /** Short label for the default list-row renderer and the default
   *  search filter. Overridden by renderItem / getSearchText. */
  getLabel: (item: T) => string;
  /** Search-index string. Defaults to getLabel. */
  getSearchText?: (item: T) => string;
  /** Custom row renderer. Receives the item + whether it's selected.
   *  Default: a plain text button with the label. */
  renderItem?: (item: T, selected: boolean) => ReactNode;
  /** Main-panel content for the current selection. Called with `null`
   *  when nothing is selected — use that to render an empty state or
   *  a create form. */
  renderDetail: (item: T | null) => ReactNode;
  /** Controlled selection id. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Header title above the list. Optional. */
  title?: string;
  /** When set, a "create" button appears above the list. Clicking it
   *  invokes this callback — typically sets the selection to null so
   *  renderDetail(null) can display a creation form. */
  onCreate?: () => void;
  createLabel?: string;
  /** Close button top-right of the main panel (optional). */
  onClose?: () => void;
  /** Placeholder in the search input. */
  searchPlaceholder?: string;
  /** Message when the list is empty AND the search query is empty. */
  emptyListMessage?: string;
}

export function ListDetailView<T>({
  items,
  getId,
  getLabel,
  getSearchText,
  renderItem,
  renderDetail,
  selectedId,
  onSelect,
  title,
  onCreate,
  createLabel = 'Create new',
  onClose,
  searchPlaceholder = 'Search…',
  emptyListMessage = 'No items yet.',
}: ListDetailViewProps<T>) {
  const [query, setQuery] = useState('');
  const extractSearch = getSearchText ?? getLabel;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => extractSearch(item).toLowerCase().includes(q));
  }, [items, query, extractSearch]);

  const selected = useMemo(
    () => items.find((item) => getId(item) === selectedId) ?? null,
    [items, selectedId, getId],
  );

  const defaultRenderItem = (item: T, isSelected: boolean) => (
    <span className={`list-detail-row-label${isSelected ? ' selected' : ''}`}>
      {getLabel(item)}
    </span>
  );

  return (
    <div className="list-detail-view">
      <aside className="list-detail-rail">
        {title && <div className="list-detail-title">{title}</div>}
        {onCreate && (
          <button
            type="button"
            className="list-detail-create"
            onClick={onCreate}
          >
            + {createLabel}
          </button>
        )}
        <input
          type="search"
          className="list-detail-search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="list-detail-list">
          {filtered.length === 0 && (
            <div className="list-detail-empty">
              {query ? 'No matches.' : emptyListMessage}
            </div>
          )}
          {filtered.map((item) => {
            const id = getId(item);
            const isSelected = id === selectedId;
            return (
              <button
                key={id}
                type="button"
                className={`list-detail-row${isSelected ? ' selected' : ''}`}
                onClick={() => onSelect(id)}
              >
                {(renderItem ?? defaultRenderItem)(item, isSelected)}
              </button>
            );
          })}
        </div>
      </aside>
      <main className="list-detail-main">
        {onClose && (
          <button
            type="button"
            className="list-detail-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
        {renderDetail(selected)}
      </main>
    </div>
  );
}
