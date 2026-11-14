// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for Cass's room (kept apart from manifest.ts so the
 *  server's tsc never traces into JSX). */
/** Browser-safe manifest: manifest.ts reads its config with node:fs, so
 *  the client takes this one instead (as blinds does). */
export const clientManifest: PluginManifest = {
  id: 'room',
  name: "Cass's room",
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { RoomSidebarSlot, RoomView } = await import('./client.js');
  const routeBase = api.routeBase;

  api.registerView({
    id: 'room',
    label: "Cass's room",
    isAvailable: () => false, // opened from the sidebar slot
    render: (props: unknown) => {
      const h = (props as { host: unknown }).host as { closeView: () => void };
      return createElement(RoomView as never, { routeBase, onClose: h.closeView });
    },
  });

  api.registerSidebarSlot({
    id: 'room-nav',
    Component: RoomSidebarSlot,
    isAvailable: () => true,
  });
}
