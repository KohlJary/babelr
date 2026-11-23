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
  // A door in Cass's room (the column beside her DM), for whoever she shares it with.
  api.registerDaemonSection?.({
    id: 'music',
    label: 'Music',
    icon: '🎧',
    order: 10,
    place: 'door',
    isAvailable: async (daemon) => {
      if (daemon.name !== 'cass') return false;
      const r = await fetch(`${routeBase}/configured`, { credentials: 'include' }).catch(
        () => null,
      );
      return !!r?.ok && !!((await r.json()) as { configured?: boolean }).configured;
    },
    open: (props) => (props as { host: { openView: (id: string) => void } }).host.openView('music'),
  });
  api.registerSidebarSlot({
    id: 'music-nav',
    Component: (props: { host: unknown }) =>
      createElement(MusicSidebarSlot as never, { ...props, routeBase: api.routeBase }),
    isAvailable: () => true,
  });
}
