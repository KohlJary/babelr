// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for the daemon panels (manifest.ts reads its config with node:fs). */
export const clientManifest: PluginManifest = {
  id: 'panel',
  name: 'Daemon panels',
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { PanelSidebarSlot, PanelView, WorkInline, WorkPreview, RoomWork, sharedDaemons } =
    await import('./client.js');
  const routeBase = api.routeBase;
  // Her work, in her room (the column beside her DM), if she shares her panel with you.
  api.registerDaemonSection?.({
    id: 'work',
    label: 'Work',
    icon: '📄',
    order: 10,
    place: 'section',
    isAvailable: async (daemon) => (await sharedDaemons(routeBase)).includes(daemon.name),
    render: (props: unknown) =>
      createElement(RoomWork as never, { ...(props as Record<string, unknown>), routeBase }),
  });
  // [[work:<daemon>/<project>/<file>]]: a daemon shows you her work; in her DM
  // it opens in the sidebar by itself (ChatView).
  api.registerEmbed({
    kind: 'work',
    label: 'Daemon work',
    navigateLabel: 'Open panels',
    renderInline: (props: unknown) =>
      createElement(WorkInline as never, { ...(props as Record<string, unknown>), routeBase }),
    renderPreview: (props: unknown) =>
      createElement(WorkPreview as never, { ...(props as Record<string, unknown>), routeBase }),
    navigate: (_args, ctx) => {
      (ctx as { openView: (id: string) => void }).openView('panel');
    },
  });
  api.registerView({
    id: 'panel',
    label: 'Daemon panels',
    isAvailable: () => false,
    render: (props: unknown) => {
      const h = (props as { host: unknown }).host as { closeView: () => void };
      return createElement(PanelView as never, { routeBase, onClose: h.closeView });
    },
  });
  api.registerSidebarSlot({
    id: 'panel-nav',
    Component: (props: { host: unknown }) =>
      createElement(PanelSidebarSlot as never, { ...props, routeBase: api.routeBase }),
    isAvailable: () => true,
  });
}
