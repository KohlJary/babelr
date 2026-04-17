// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import { T } from '../../../client/src/components/T.js';
import { E } from '../../../client/src/components/E.js';
import type { WorkItemView } from '../manifest.js';

/** Window event the task-kind embed's "Edit" button dispatches. The
 *  PmView listens and opens its edit modal in response. Keeps the
 *  sidebar preview and the edit modal loosely coupled — sidebar is
 *  in the EmbedSidebar host, modal is in PmView. */
export const EDIT_EVENT = 'babelr:plugin:project-management:edit-requested';

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

export function useTaskItem(slug: string, routeBase: string): TaskState {
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
