// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState, useCallback } from 'react';
import { ListDetailView } from '../../client/src/components/ListDetailView.js';
import { T } from '../../client/src/components/T.js';
import { E } from '../../client/src/components/E.js';
import { onWsMessage } from '../../client/src/plugins/ws-helper.js';
import { useChat } from '../../client/src/hooks/useChat.js';
import { useTranslation } from '../../client/src/hooks/useTranslation.js';
import { useTranslationSettings } from '../../client/src/hooks/useTranslationSettings.js';
import { MessageList } from '../../client/src/components/MessageList.js';
import { MessageInput } from '../../client/src/components/MessageInput.js';
import type { ActorProfile } from '@babelr/shared';
import type {
  BoardSummary,
  BoardDetail,
  ColumnView,
  WorkItemView,
} from './manifest.js';

/**
 * Client components for the project-management plugin.
 *
 * Task-pm-2 scope: board list + empty kanban on select.
 * - PmSidebarSlot: "📋 Boards" button, opens the main-panel view.
 * - PmView: ListDetailView wrapping boards on the left, selected
 *   board's kanban (columns + [empty] lanes) on the right. New-board
 *   flow uses the same create-in-main-panel pattern polls uses.
 * - BoardKanban: columns side-by-side, empty lanes. Work-item cards
 *   land in task-pm-3; drag-and-drop in task-pm-4.
 *
 * Translation: <T> wrapping on all user-authored strings (board name,
 * column name, description). Zero manual translation wiring — the
 * Phase 3 primitive does the work.
 */

interface PmHost {
  routeBase: string;
  selectedServerId: string | null;
  selectedServerName: string | null;
  openView: (id: string) => void;
}

type OpenEmbedPreview = (kind: string, slug: string, serverSlug?: string) => void;

interface PmViewProps {
  routeBase: string;
  serverId: string | null;
  serverName: string | null;
  actor: ActorProfile;
  onClose: () => void;
  openEmbedPreview: OpenEmbedPreview;
}

/** Window event the task-kind embed's "Edit" button dispatches. The
 *  PmView listens and opens its edit modal in response. Keeps the
 *  sidebar preview and the edit modal loosely coupled — sidebar is
 *  in the EmbedSidebar host, modal is in PmView. */
const EDIT_EVENT = 'babelr:plugin:project-management:edit-requested';

/** Window event the board-kind embed's navigate button dispatches.
 *  Detail is the board slug. PmView listens and deep-links to that
 *  board (selecting it in the board list). */
const OPEN_BOARD_EVENT = 'babelr:plugin:project-management:open-board';

export function PmSidebarSlot(props: { host: unknown }) {
  const host = props.host as PmHost;
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('project-management')}
    >
      📋 <T>Boards</T>
    </button>
  );
}

interface CreateBoardFormProps {
  routeBase: string;
  serverId: string;
  onCreated: (board: BoardDetail) => void;
}

function CreateBoardForm({ routeBase, serverId, onCreated }: CreateBoardFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      // Error strings are not <T>-wrapped — they're structural, not
      // user-authored content.
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${routeBase}/boards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId,
          name: name.trim(),
          description: description.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Failed to create board');
        setSubmitting(false);
        return;
      }
      const board = (await res.json()) as BoardDetail;
      onCreated(board);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="pm-create-form">
      <h3><T>New board</T></h3>
      <label className="pm-form-field">
        <span><T>Name</T></span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sprint planning, Q2 roadmap, Bug triage…"
        />
      </label>
      <label className="pm-form-field">
        <span><T>Description (optional)</T></span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What is this board for?"
        />
      </label>
      {error && <div className="pm-form-error">{error}</div>}
      <div className="pm-form-actions">
        <button
          type="button"
          className="pm-form-submit"
          disabled={submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? <T>Creating…</T> : <T>Create board</T>}
        </button>
      </div>
    </div>
  );
}

interface BoardKanbanProps {
  board: BoardDetail | null;
  routeBase: string;
  onMutated: () => void;
  /** Apply an optimistic mutation to the board locally — used for DnD
   *  so the card appears in its new column before the server confirms. */
  onLocalBoardUpdate: (next: BoardDetail) => void;
  openEmbedPreview: OpenEmbedPreview;
}

function BoardKanban({
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

export function PmView(props: PmViewProps) {
  const { routeBase, serverId, serverName, actor, onClose, openEmbedPreview } = props;
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<BoardDetail | null>(null);
  const [creating, setCreating] = useState(false);

  const reloadBoards = useCallback(async () => {
    if (!serverId) {
      setBoards([]);
      return;
    }
    const res = await fetch(
      `${routeBase}/boards?serverId=${encodeURIComponent(serverId)}`,
      { credentials: 'include' },
    );
    if (!res.ok) return;
    const data = (await res.json()) as BoardSummary[];
    setBoards(data);
  }, [routeBase, serverId]);

  useEffect(() => {
    void reloadBoards();
  }, [reloadBoards]);

  // Deep-link from a [[board:slug]] embed. Navigate handlers fire the
  // OPEN_BOARD_EVENT with the slug; PmView selects that board.
  useEffect(() => {
    const handler = (ev: Event) => {
      const slug = (ev as CustomEvent<string>).detail;
      if (slug) {
        setCreating(false);
        setSelectedSlug(slug);
      }
    };
    window.addEventListener(OPEN_BOARD_EVENT, handler);
    return () => window.removeEventListener(OPEN_BOARD_EVENT, handler);
  }, []);

  // Keep the board list fresh — item counts drift as other clients
  // create/delete work items, and newly-created boards should appear
  // without a manual reload.
  useEffect(() => {
    const unsub = onWsMessage<{ boardSlug: string }>(
      'plugin:pm:updated',
      () => {
        void reloadBoards();
      },
    );
    return unsub;
  }, [reloadBoards]);

  // When the selection changes, fetch the full detail (columns + items).
  useEffect(() => {
    if (!selectedSlug) {
      setSelectedBoard(null);
      return;
    }
    let cancelled = false;
    void fetch(`${routeBase}/boards/${encodeURIComponent(selectedSlug)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as BoardDetail;
      })
      .then((detail) => {
        if (!cancelled) setSelectedBoard(detail);
      });
    return () => {
      cancelled = true;
    };
  }, [routeBase, selectedSlug]);

  return (
    <ListDetailView<BoardSummary>
      title={serverName ? `Boards · ${serverName}` : 'Boards'}
      items={boards}
      getId={(b) => b.slug}
      getLabel={(b) => b.name}
      getSearchText={(b) => `${b.name} ${b.description ?? ''}`}
      renderItem={(b) => (
        <span className="pm-list-row">
          <span className="pm-list-row-name">
            <T>{b.name}</T>
          </span>
          <span className="pm-list-row-meta">
            {b.workItemCount} item{b.workItemCount === 1 ? '' : 's'}
          </span>
        </span>
      )}
      selectedId={creating ? null : selectedSlug}
      onSelect={(id) => {
        setCreating(false);
        setSelectedSlug(id);
      }}
      onCreate={
        serverId
          ? () => {
              setCreating(true);
              setSelectedSlug(null);
            }
          : undefined
      }
      createLabel="New board"
      emptyListMessage={
        serverId
          ? 'No boards yet. Click "New board" to create one.'
          : 'Select a server to see its boards.'
      }
      searchPlaceholder="Search boards…"
      onClose={onClose}
      renderDetail={() => {
        if (creating && serverId) {
          return (
            <CreateBoardForm
              routeBase={routeBase}
              serverId={serverId}
              onCreated={(board) => {
                setCreating(false);
                setSelectedSlug(board.slug);
                void reloadBoards();
              }}
            />
          );
        }
        if (selectedSlug && !selectedBoard) {
          return (
            <div className="pm-view-empty">
              <T>Loading board…</T>
            </div>
          );
        }
        if (!selectedBoard) {
          return (
            <div className="pm-view-empty">
              <T>Select a board from the left, or create a new one.</T>
            </div>
          );
        }
        return (
          <BoardKanban
            board={selectedBoard}
            actor={actor}
            routeBase={routeBase}
            openEmbedPreview={openEmbedPreview}
            onLocalBoardUpdate={setSelectedBoard}
            onMutated={() => {
              // Refetch the board after any mutation so positions and
              // counts stay consistent with the server. Cheap for now;
              // task-pm-7 adds WS-driven real-time sync instead.
              if (selectedSlug) {
                void fetch(
                  `${routeBase}/boards/${encodeURIComponent(selectedSlug)}`,
                  { credentials: 'include' },
                )
                  .then(async (res) => (res.ok ? ((await res.json()) as BoardDetail) : null))
                  .then((detail) => setSelectedBoard(detail));
              }
              void reloadBoards();
            }}
          />
        );
      }}
    />
  );
}

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const ITEM_TYPES = ['task', 'bug', 'story', 'epic'] as const;

interface WorkItemDetailModalProps {
  item: WorkItemView;
  actor: ActorProfile;
  routeBase: string;
  onClose: () => void;
  onMutated: () => void;
}

function WorkItemDetailModal({
  item,
  actor,
  routeBase,
  onClose,
  onMutated,
}: WorkItemDetailModalProps) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [priority, setPriority] = useState(item.priority);
  const [itemType, setItemType] = useState(item.itemType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    title.trim() !== item.title ||
    description !== (item.description ?? '') ||
    priority !== item.priority ||
    itemType !== item.itemType;

  const handleSave = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${routeBase}/work-items/${encodeURIComponent(item.slug)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim() || null,
            priority,
            itemType,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Save failed');
        setSaving(false);
        return;
      }
      onMutated();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this card?')) return;
    setSaving(true);
    try {
      const res = await fetch(
        `${routeBase}/work-items/${encodeURIComponent(item.slug)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (res.ok) onMutated();
      else setSaving(false);
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="pm-modal-overlay" onClick={onClose}>
      <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="pm-modal-header">
          <h3><T>Work item</T></h3>
          <button type="button" className="pm-modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="pm-modal-body">
          <label className="pm-form-field">
            <span><T>Title</T></span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="pm-form-field">
            <span><T>Description</T></span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
            />
          </label>
          <div className="pm-modal-row">
            <label className="pm-form-field">
              <span><T>Priority</T></span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-form-field">
              <span><T>Type</T></span>
              <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
                {ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="pm-form-error">{error}</div>}
          {item.chatId && (
            <div className="pm-modal-comments">
              <div className="pm-modal-comments-label">
                <T>Comments</T>
              </div>
              <TaskComments actor={actor} chatId={item.chatId} />
            </div>
          )}
        </div>
        <footer className="pm-modal-footer">
          <button
            type="button"
            className="pm-modal-delete"
            onClick={() => void handleDelete()}
            disabled={saving}
          >
            <T>Delete</T>
          </button>
          <div className="pm-modal-footer-right">
            <button type="button" onClick={onClose} disabled={saving}>
              <T>Cancel</T>
            </button>
            <button
              type="button"
              className="pm-form-submit"
              disabled={!dirty || !title.trim() || saving}
              onClick={() => void handleSave()}
            >
              {saving ? <T>Saving…</T> : <T>Save</T>}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}


/**
 * Read-only detail rendered in the embed sidebar when a user clicks a
 * work item card (or pastes [[task:slug]] anywhere, once task-pm-6
 * wires the embed parser path). All translatable content goes through
 * <T>. An "Edit" button navigates back to the modal via the window
 * event — keeps sidebar (preview-only) and kanban modal (edit)
 * decoupled.
 */
interface TaskPreviewProps {
  slug: string;
  routeBase: string;
}

type TaskState =
  | { status: 'loading' }
  | { status: 'ok'; item: WorkItemView }
  | { status: 'locked' };

function useTaskItem(slug: string, routeBase: string): TaskState {
  const [state, setState] = useState<TaskState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`${routeBase}/work-items/${encodeURIComponent(slug)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('locked');
        return (await res.json()) as WorkItemView;
      })
      .then((item) => {
        if (!cancelled) setState({ status: 'ok', item });
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

export function TaskPreview(props: Record<string, unknown>) {
  const { slug, routeBase } = props as unknown as TaskPreviewProps;
  const state = useTaskItem(slug, routeBase);
  if (state.status === 'loading') {
    return <div className="embed-preview-loading"><T>Loading work item…</T></div>;
  }
  if (state.status === 'locked') {
    return <div className="embed-preview-locked"><T>Work item not found.</T></div>;
  }
  const { item } = state;
  return (
    <div className="pm-task-preview">
      <h3 className="pm-task-preview-title">
        <T>{item.title}</T>
      </h3>
      <div className="pm-task-preview-meta">
        <span className={`pm-card-priority priority-${item.priority}`}>
          <T>{item.priority}</T>
        </span>
        <span className={`pm-card-type type-${item.itemType}`}><T>{item.itemType}</T></span>
      </div>
      {item.description && (
        <div className="pm-task-preview-description">
          <E>{item.description}</E>
        </div>
      )}
      <dl className="pm-task-preview-fields">
        {item.storyPoints !== null && (
          <>
            <dt><T>Points</T></dt>
            <dd>{item.storyPoints}</dd>
          </>
        )}
        {item.dueDate && (
          <>
            <dt><T>Due</T></dt>
            <dd>{new Date(item.dueDate).toLocaleString()}</dd>
          </>
        )}
        <dt><T>Created</T></dt>
        <dd>{new Date(item.createdAt).toLocaleString()}</dd>
      </dl>
    </div>
  );
}

/**
 * Minimal inline renderer for [[task:slug]] refs. Task-pm-6 gives it
 * a richer card; for now a compact button that opens the sidebar
 * preview, same affordance the kanban cards use.
 */
export function TaskInline(props: Record<string, unknown>) {
  const { slug, routeBase, onClick } = props as unknown as TaskPreviewProps & {
    onClick: () => void;
  };
  const state = useTaskItem(slug, routeBase);
  if (state.status !== 'ok') {
    return (
      <button type="button" className="pm-task-inline loading" onClick={onClick}>
        📋 {state.status === 'locked' ? <T>Task not found</T> : <T>Loading task…</T>}
      </button>
    );
  }
  const { item } = state;
  return (
    <button type="button" className="pm-task-inline" onClick={onClick}>
      <span className="pm-task-inline-icon">📋</span>
      <span className="pm-task-inline-body">
        <span className="pm-task-inline-title">
          <T>{item.title}</T>
        </span>
        <span className="pm-task-inline-meta">
          {item.priority} · {item.itemType}
        </span>
      </span>
    </button>
  );
}

/**
 * Embedded comment thread for a work item. Each item's chat_id points
 * at an OrderedCollection (created server-side at item-create time),
 * which makes the existing useChat / MessageList / MessageInput stack
 * work out-of-the-box — translation, reactions, and threading all
 * come for free via the core chat pipeline.
 */
function TaskComments({
  actor,
  chatId,
}: {
  actor: ActorProfile;
  chatId: string;
}) {
  const {
    messages,
    loading,
    hasMore,
    sendMessage,
    loadMore,
    typingUsers: _typingUsers,
    notifyTyping,
  } = useChat(actor, chatId, false);
  void _typingUsers;
  const { settings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);
  return (
    <div className="pm-comments">
      <MessageList
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={loadMore}
        translations={translations}
        isTranslating={isTranslating}
        actor={actor}
      />
      <MessageInput
        onSend={sendMessage}
        disabled={loading}
        onTyping={notifyTyping}
      />
    </div>
  );
}

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

function useBoard(slug: string, routeBase: string): BoardState {
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

export { EDIT_EVENT, OPEN_BOARD_EVENT };
