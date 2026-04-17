// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState, useCallback } from 'react';
import { T } from '../../../client/src/components/T.js';
import { E } from '../../../client/src/components/E.js';
import { onWsMessage } from '../../../client/src/plugins/ws-helper.js';
import { WorkItemDetailModal } from './WorkItemModal.js';
import { EDIT_EVENT } from './TaskEmbed.js';
import type { ActorProfile } from '@babelr/shared';
import type { BoardDetail, ColumnView, WorkItemView } from '../manifest.js';

type OpenEmbedPreview = (kind: string, slug: string, serverSlug?: string) => void;

export interface BoardKanbanProps {
  board: BoardDetail | null;
  routeBase: string;
  onMutated: () => void;
  /** Apply an optimistic mutation to the board locally — used for DnD
   *  so the card appears in its new column before the server confirms. */
  onLocalBoardUpdate: (next: BoardDetail) => void;
  openEmbedPreview: OpenEmbedPreview;
}

export function BoardKanban({
  board,
  routeBase,
  actor,
  onMutated,
  onLocalBoardUpdate,
  openEmbedPreview,
}: BoardKanbanProps & { actor: ActorProfile }) {
  const [editing, setEditing] = useState<WorkItemView | null>(null);
  const [dragSlug, setDragSlug] = useState<string | null>(null);

  // Drop handler — compute the new per-column ordering, apply it
  // optimistically, then POST the reorder. On server error, roll back
  // to the pre-drop snapshot and refetch for truth.
  const handleDrop = useCallback(
    async (srcSlug: string, destColumnId: string, destIndex: number) => {
      if (!board) return;
      const snapshot = board;
      // Find source column + item.
      const srcCol = board.columns.find((c) =>
        c.workItems.some((i) => i.slug === srcSlug),
      );
      if (!srcCol) return;
      const item = srcCol.workItems.find((i) => i.slug === srcSlug);
      if (!item) return;

      const sameColumn = srcCol.id === destColumnId;
      const destCol = sameColumn
        ? srcCol
        : board.columns.find((c) => c.id === destColumnId);
      if (!destCol) return;

      // Build the new ordering for the affected columns.
      const srcItemsAfter = srcCol.workItems.filter((i) => i.slug !== srcSlug);
      const destItemsAfter = sameColumn
        ? srcItemsAfter.slice()
        : destCol.workItems.slice();
      const clampedIndex = Math.max(0, Math.min(destIndex, destItemsAfter.length));
      const movedItem: WorkItemView = { ...item, columnId: destColumnId };
      destItemsAfter.splice(clampedIndex, 0, movedItem);

      // No-op detection — same column, same slot.
      if (sameColumn) {
        const originalOrder = srcCol.workItems.map((i) => i.slug).join(',');
        const newOrder = destItemsAfter.map((i) => i.slug).join(',');
        if (originalOrder === newOrder) return;
      }

      const nextColumns = board.columns.map((c) => {
        if (c.id === srcCol.id && c.id === destCol.id) {
          return { ...c, workItems: destItemsAfter };
        }
        if (c.id === srcCol.id) return { ...c, workItems: srcItemsAfter };
        if (c.id === destCol.id) return { ...c, workItems: destItemsAfter };
        return c;
      });
      onLocalBoardUpdate({ ...board, columns: nextColumns });

      const assignments = sameColumn
        ? [{ columnId: destCol.id, itemIds: destItemsAfter.map((i) => i.slug) }]
        : [
            { columnId: srcCol.id, itemIds: srcItemsAfter.map((i) => i.slug) },
            { columnId: destCol.id, itemIds: destItemsAfter.map((i) => i.slug) },
          ];

      try {
        // Server's reorder endpoint accepts work-item slugs as
        // itemIds (the client never has the row uuid).
        const res = await fetch(
          `${routeBase}/boards/${encodeURIComponent(board.slug)}/reorder`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignments }),
          },
        );
        if (!res.ok) throw new Error('reorder failed');
        // Refetch for canonical position numbers (and to pick up any
        // concurrent edits from other clients).
        onMutated();
      } catch (err) {
        console.error('[pm] reorder failed, rolling back', err);
        onLocalBoardUpdate(snapshot);
        onMutated();
      }
    },
    [board, routeBase, onLocalBoardUpdate, onMutated],
  );

  // The task-kind embed's "Edit" button dispatches an EDIT_EVENT with
  // the slug of the work item to edit. Any mounted BoardKanban (there's
  // typically only one — the selected board) catches it, fetches the
  // item, and pops the modal. Decoupling via a window event means the
  // sidebar preview doesn't need a direct reference to the kanban.
  useEffect(() => {
    const handler = (ev: Event) => {
      const slug = (ev as CustomEvent<string>).detail;
      if (!slug || !board) return;
      const flat = board.columns.flatMap((c) => c.workItems);
      const item = flat.find((i) => i.slug === slug);
      if (item) setEditing(item);
    };
    window.addEventListener(EDIT_EVENT, handler);
    return () => window.removeEventListener(EDIT_EVENT, handler);
  }, [board]);

  // Real-time sync — any client that creates / edits / moves / deletes
  // a work item (or creates a new board) on this tower broadcasts
  // plugin:pm:updated. We refetch when the event's boardSlug matches
  // the one we're viewing. Our own mutations already refetch via
  // onMutated, so the extra roundtrip from hearing our own echo is
  // at worst a no-op (and keeps the code path singular).
  useEffect(() => {
    if (!board) return;
    const unsub = onWsMessage<{ boardSlug: string }>(
      'plugin:pm:updated',
      (payload) => {
        if (payload.boardSlug === board.slug) onMutated();
      },
    );
    return unsub;
  }, [board, onMutated]);

  if (!board) return null;
  return (
    <>
      <div className="pm-board">
        <header className="pm-board-header">
          <h3 className="pm-board-title">
            <T>{board.name}</T>
          </h3>
          {board.description && (
            <p className="pm-board-description">
              <E>{board.description}</E>
            </p>
          )}
        </header>
        <div className="pm-columns">
          {board.columns.map((col) => (
            <BoardColumn
              key={col.id}
              column={col}
              boardSlug={board.slug}
              routeBase={routeBase}
              onMutated={onMutated}
              onOpenItem={(item) => openEmbedPreview('task', item.slug)}
              dragSlug={dragSlug}
              onDragStart={setDragSlug}
              onDragEnd={() => setDragSlug(null)}
              onDrop={handleDrop}
            />
          ))}
        </div>
      </div>
      {editing && (
        <WorkItemDetailModal
          item={editing}
          actor={actor}
          routeBase={routeBase}
          onClose={() => setEditing(null)}
          onMutated={() => {
            setEditing(null);
            onMutated();
          }}
        />
      )}
    </>
  );
}

interface BoardColumnProps {
  column: ColumnView;
  boardSlug: string;
  routeBase: string;
  onMutated: () => void;
  onOpenItem: (item: WorkItemView) => void;
  dragSlug: string | null;
  onDragStart: (slug: string) => void;
  onDragEnd: () => void;
  onDrop: (srcSlug: string, destColumnId: string, destIndex: number) => void;
}

function BoardColumn({
  column,
  boardSlug,
  routeBase,
  onMutated,
  onOpenItem,
  dragSlug,
  onDragStart,
  onDragEnd,
  onDrop,
}: BoardColumnProps) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Which insertion slot the current hover points at. null = not a
  // valid drop target right now (no drag in progress). -1 means the
  // bottom of the column (drop zone below the last card).
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const handleCreate = async () => {
    if (!newTitle.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `${routeBase}/boards/${encodeURIComponent(boardSlug)}/work-items`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: column.id, title: newTitle.trim() }),
        },
      );
      if (res.ok) {
        setNewTitle('');
        setAdding(false);
        onMutated();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const dragActive = dragSlug !== null;

  const finishDrop = (destIndex: number) => {
    if (!dragSlug) return;
    onDrop(dragSlug, column.id, destIndex);
    setHoverIndex(null);
  };

  return (
    <section
      className={`pm-column${dragActive ? ' pm-column-drop-ready' : ''}`}
      aria-label={column.name}
      aria-roledescription="kanban column"
      data-drop-active={dragActive || undefined}
      onDragLeave={(e) => {
        // Only clear if the pointer actually left the column. Children
        // fire dragleave when the cursor crosses their boundary too —
        // we don't want that to blow away hoverIndex.
        const related = e.relatedTarget as Node | null;
        if (!e.currentTarget.contains(related)) setHoverIndex(null);
      }}
    >
      <header className="pm-column-header">
        <span className="pm-column-name">
          <T>{column.name}</T>
        </span>
        <span className="pm-column-count">{column.workItems.length}</span>
      </header>
      <div className="pm-column-list">
        {column.workItems.length === 0 && !adding && (
          <div
            className={`pm-column-empty${
              dragActive && hoverIndex === 0 ? ' pm-column-drop-hover' : ''
            }`}
            onDragOver={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              setHoverIndex(0);
            }}
            onDrop={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              finishDrop(0);
            }}
          >
            <T>Nothing here yet.</T>
          </div>
        )}
        {column.workItems.map((item, idx) => (
          <div
            key={item.slug}
            className={`pm-card-slot${
              dragActive && hoverIndex === idx ? ' pm-card-slot-before' : ''
            }`}
            onDragOver={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const isTopHalf = e.clientY - rect.top < rect.height / 2;
              setHoverIndex(isTopHalf ? idx : idx + 1);
            }}
            onDrop={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const isTopHalf = e.clientY - rect.top < rect.height / 2;
              finishDrop(isTopHalf ? idx : idx + 1);
            }}
          >
            <WorkItemCard
              item={item}
              onOpen={() => onOpenItem(item)}
              isDragging={dragSlug === item.slug}
              onDragStart={() => onDragStart(item.slug)}
              onDragEnd={onDragEnd}
            />
          </div>
        ))}
        {column.workItems.length > 0 && (
          <div
            className={`pm-column-drop-tail${
              dragActive && hoverIndex === column.workItems.length
                ? ' pm-column-drop-hover'
                : ''
            }`}
            onDragOver={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              setHoverIndex(column.workItems.length);
            }}
            onDrop={(e) => {
              if (!dragActive) return;
              e.preventDefault();
              finishDrop(column.workItems.length);
            }}
          />
        )}
        {adding ? (
          <form
            className="pm-column-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Card title"
              autoFocus
            />
            <div className="pm-column-add-actions">
              <button type="submit" disabled={submitting || !newTitle.trim()}>
                <T>Add</T>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewTitle('');
                }}
              >
                <T>Cancel</T>
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="pm-column-add-btn"
            onClick={() => setAdding(true)}
          >
            + <T>Add card</T>
          </button>
        )}
      </div>
    </section>
  );
}

function WorkItemCard({
  item,
  onOpen,
  isDragging,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItemView;
  onOpen: () => void;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <article
      className={`pm-card${isDragging ? ' pm-card-dragging' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      draggable
      aria-roledescription="draggable card"
      aria-label={item.title}
      onDragStart={(e) => {
        // Setting plaintext data keeps Firefox happy — it treats
        // drags without dataTransfer payload as cancelled on some
        // platforms.
        e.dataTransfer.setData('text/plain', item.slug);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="pm-card-title">
        <T>{item.title}</T>
      </div>
      {item.description && (
        <div className="pm-card-description">
          <E>{item.description}</E>
        </div>
      )}
      <div className="pm-card-meta">
        <span className={`pm-card-priority priority-${item.priority}`}>
          {item.priority}
        </span>
        <span className={`pm-card-type type-${item.itemType}`}>{item.itemType}</span>
      </div>
    </article>
  );
}
