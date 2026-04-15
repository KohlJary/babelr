// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the polls plugin. Kept separate from
 * manifest.ts so the server's tsc pass never traces into the
 * JSX/bundler-resolution client code. The client's registered.ts
 * imports this module explicitly and runs setupClient after the
 * manifest's server-side bits have already loaded.
 */

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { PollInline, PollPreview, PollsSidebarSlot, PollsView } = await import(
    './client.js'
  );
  const routeBase = api.routeBase;

  // Bind the plugin's routeBase into the embed components once so the
  // registered shape matches the SDK's (props: unknown) => unknown
  // contract. The SDK mounts these via createElement, so hooks inside
  // the underlying components are tracked correctly.
  const PollInlineBound = (props: unknown) =>
    createElement(PollInline as never, {
      ...(props as Record<string, unknown>),
      routeBase,
    });
  const PollPreviewBound = (props: unknown) =>
    createElement(PollPreview as never, {
      ...(props as Record<string, unknown>),
      routeBase,
    });

  api.registerEmbed({
    kind: 'poll',
    label: 'Poll',
    navigateLabel: 'View poll',
    renderInline: PollInlineBound,
    renderPreview: PollPreviewBound,
    navigate: () => {
      // Polls have a main-panel view; navigate-to-view is handled
      // by the sidebar slot, not the embed's open button.
    },
  });

  const PollsViewBound = (props: unknown) => {
    const h = (props as { host: unknown }).host as {
      selectedServer: { id: string; name: string } | null;
      closeView: () => void;
    };
    return createElement(PollsView as never, {
      routeBase,
      serverId: h.selectedServer?.id ?? null,
      serverName: h.selectedServer?.name ?? null,
      onClose: h.closeView,
    });
  };

  api.registerView({
    id: 'polls',
    label: 'Polls',
    isAvailable: () => false, // no toolbar entry; opened via the sidebar slot
    render: PollsViewBound,
  });

  api.registerSidebarSlot({
    id: 'polls-nav',
    Component: PollsSidebarSlot,
    isAvailable: (host) =>
      (host as { selectedServerId: string | null }).selectedServerId !== null,
  });
}
