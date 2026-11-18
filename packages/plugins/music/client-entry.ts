// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for Cass's music (manifest.ts reads its config with node:fs). */
export const clientManifest: PluginManifest = {
  id: 'music',
  name: "Cass's music",
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { MusicSidebarSlot, MusicView } = await import('./client.js');
  const routeBase = api.routeBase;
  api.registerView({
    id: 'music',
    label: "Cass's music",
    isAvailable: () => false,
    render: (props: unknown) => {
      const h = (props as { host: unknown }).host as { closeView: () => void };
      return createElement(MusicView as never, { routeBase, onClose: h.closeView });
    },
  });
  api.registerSidebarSlot({
    id: 'music-nav',
    Component: MusicSidebarSlot,
    isAvailable: () => true,
  });
}
