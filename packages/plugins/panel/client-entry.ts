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
  const { PanelSidebarSlot, PanelView } = await import('./client.js');
  const routeBase = api.routeBase;
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
