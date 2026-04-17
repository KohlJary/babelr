// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState, useCallback } from 'react';
import { ListDetailView } from '../../client/src/components/ListDetailView.js';
import { T } from '../../client/src/components/T.js';
import { onWsMessage } from '../../client/src/plugins/ws-helper.js';
import { BoardKanban } from './components/Board.js';
import { TaskPreview, TaskInline, EDIT_EVENT } from './components/TaskEmbed.js';
import { BoardPreview, BoardInline, OPEN_BOARD_EVENT } from './components/BoardEmbed.js';
import type { ActorProfile } from '@babelr/shared';
import type {
  BoardSummary,
  BoardDetail,
} from './manifest.js';

/**
 * Client barrel for the project-management plugin.
 *
 * Orchestrates the sidebar slot, the ListDetailView-based main view,
 * and re-exports the embed renderers + constants that client-entry.ts
 * needs.
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

// Re-exports for client-entry.ts
export { CreateBoardForm };
export { TaskPreview, TaskInline, EDIT_EVENT } from './components/TaskEmbed.js';
export { BoardPreview, BoardInline, OPEN_BOARD_EVENT } from './components/BoardEmbed.js';
