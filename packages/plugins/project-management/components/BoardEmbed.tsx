// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import { T } from '../../../client/src/components/T.js';
import { E } from '../../../client/src/components/E.js';
import type { BoardDetail } from '../manifest.js';

/** Window event the board-kind embed's navigate button dispatches.
 *  Detail is the board slug. PmView listens and deep-links to that
 *  board (selecting it in the board list). */
export const OPEN_BOARD_EVENT = 'babelr:plugin:project-management:open-board';

/**
 * Read-only board preview for [[board:slug]] embeds. Renders a mini
 * kanban with column names + item counts + the top three card titles
 * per column. Tradeoff: full card rendering would mirror the live
 * board but drown the sidebar — the top-3 sample gives enough
 * signal to decide whether to click through.
 */
interface BoardPreviewProps {
  slug: string;
  routeBase: string;
}

type BoardState =
  | { status: 'loading' }
  | { status: 'ok'; board: BoardDetail }
  | { status: 'locked' };

export function useBoard(slug: string, routeBase: string): BoardState {
  const [state, setState] = useState<BoardState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`${routeBase}/boards/${encodeURIComponent(slug)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('locked');
        return (await res.json()) as BoardDetail;
      })
      .then((board) => {
        if (!cancelled) setState({ status: 'ok', board });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'locked' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, routeBase]);
  return state;
}

export function BoardPreview(props: Record<string, unknown>) {
  const { slug, routeBase } = props as unknown as BoardPreviewProps;
  const state = useBoard(slug, routeBase);
  if (state.status === 'loading') {
    return <div className="embed-preview-loading"><T>Loading board…</T></div>;
  }
  if (state.status === 'locked') {
    return <div className="embed-preview-locked"><T>Board not found.</T></div>;
  }
  const { board } = state;
  return (
    <div className="pm-board-preview">
      <h3 className="pm-board-preview-title">
        <T>{board.name}</T>
      </h3>
      {board.description && (
        <div className="pm-board-preview-description">
          <E>{board.description}</E>
        </div>
      )}
      <div className="pm-board-preview-stats">
        {board.workItemCount} item{board.workItemCount === 1 ? '' : 's'} ·{' '}
        {board.columns.length} column{board.columns.length === 1 ? '' : 's'}
      </div>
      <div className="pm-board-preview-columns">
        {board.columns.map((col) => (
          <div key={col.id} className="pm-board-preview-column">
            <div className="pm-board-preview-column-header">
              <span className="pm-board-preview-column-name">
                <T>{col.name}</T>
              </span>
              <span className="pm-board-preview-column-count">
                {col.workItems.length}
              </span>
            </div>
            <ul className="pm-board-preview-column-items">
              {col.workItems.slice(0, 3).map((item) => (
                <li key={item.slug}>
                  <T>{item.title}</T>
                </li>
              ))}
              {col.workItems.length > 3 && (
                <li className="pm-board-preview-column-more">
                  +{col.workItems.length - 3} more
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Inline renderer for [[board:slug]] refs. Click opens the preview
 * sidebar (same affordance as task refs). Compact — board name plus
 * an item-count badge.
 */
export function BoardInline(props: Record<string, unknown>) {
  const { slug, routeBase, onClick } = props as unknown as BoardPreviewProps & {
    onClick: () => void;
  };
  const state = useBoard(slug, routeBase);
  if (state.status !== 'ok') {
    return (
      <button type="button" className="pm-board-inline loading" onClick={onClick}>
        📋 {state.status === 'locked' ? <T>Board not found</T> : <T>Loading board…</T>}
      </button>
    );
  }
  const { board } = state;
  return (
    <button type="button" className="pm-board-inline" onClick={onClick}>
      <span className="pm-board-inline-icon">📋</span>
      <span className="pm-board-inline-title">
        <T>{board.name}</T>
      </span>
      <span className="pm-board-inline-count">{board.workItemCount}</span>
    </button>
  );
}
