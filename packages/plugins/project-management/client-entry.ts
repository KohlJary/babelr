// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry for the project-management plugin. Matches the
 * split-file convention: manifest.ts stays server-safe, this file
 * registers anything that touches React.
 */

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const {
    PmSidebarSlot,
    PmView,
    TaskPreview,
    TaskInline,
    BoardPreview,
    BoardInline,
    EDIT_EVENT,
    OPEN_BOARD_EVENT,
  } = await import('./client.js');
  const routeBase = api.routeBase;

  type OpenEmbedPreview = (
    kind: string,
    slug: string,
    serverSlug?: string,
  ) => void;

  const PmViewBound = (props: unknown) => {
    const h = (props as { host: unknown }).host as {
      actor: unknown;
      selectedServer: { id: string; name: string } | null;
      closeView: () => void;
      openEmbedPreview: OpenEmbedPreview;
    };
    return createElement(PmView as never, {
      routeBase,
      actor: h.actor,
      serverId: h.selectedServer?.id ?? null,
      serverName: h.selectedServer?.name ?? null,
      onClose: h.closeView,
      openEmbedPreview: h.openEmbedPreview,
    });
  };

  api.registerView({
    id: 'project-management',
    label: 'Boards',
    // No toolbar entry; opened via the sidebar slot.
    isAvailable: () => false,
    render: PmViewBound,
  });

  api.registerSidebarSlot({
    id: 'project-management-nav',
    Component: PmSidebarSlot,
    isAvailable: (host) =>
      (host as { selectedServerId: string | null }).selectedServerId !== null,
  });

  // The inline/preview renderers need the plugin routeBase to fetch.
  // We bind it here so the embed registry props (slug/serverSlug/onClick)
  // stay kind-agnostic — the routeBase is a PM-plugin implementation
  // detail.
  const TaskPreviewBound = (props: unknown) =>
    createElement(TaskPreview as never, { ...(props as object), routeBase });
  const TaskInlineBound = (props: unknown) =>
    createElement(TaskInline as never, { ...(props as object), routeBase });

  api.registerEmbed({
    kind: 'task',
    label: 'Task',
    navigateLabel: 'Edit',
    renderInline: TaskInlineBound,
    renderPreview: TaskPreviewBound,
    // "Edit" routes back to the kanban modal via a window event — the
    // BoardKanban listens for it and pops WorkItemDetailModal for that
    // slug. Keeps the embed sidebar (read-only preview) decoupled from
    // the kanban (edit surface).
    navigate: (args) => {
      window.dispatchEvent(
        new CustomEvent(EDIT_EVENT, { detail: (args as { slug: string }).slug }),
      );
    },
  });

  const BoardPreviewBound = (props: unknown) =>
    createElement(BoardPreview as never, { ...(props as object), routeBase });
  const BoardInlineBound = (props: unknown) =>
    createElement(BoardInline as never, { ...(props as object), routeBase });

  api.registerEmbed({
    kind: 'board',
    label: 'Board',
    navigateLabel: 'Open Board',
    renderInline: BoardInlineBound,
    renderPreview: BoardPreviewBound,
    // Navigate opens the PM view and fires OPEN_BOARD_EVENT so PmView
    // deep-links to that board. Two hops because the view has to
    // mount first before it can listen; PmView's effect registers on
    // mount so the event fires in the next microtask.
    navigate: (args, ctx) => {
      const nav = ctx as { openView?: (id: string) => void } | undefined;
      nav?.openView?.('project-management');
      // PmView may not be mounted yet — defer the slug dispatch so its
      // useEffect listener is live by the time the event fires.
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(OPEN_BOARD_EVENT, {
            detail: (args as { slug: string }).slug,
          }),
        );
      }, 0);
    },
  });
}
