// SPDX-License-Identifier: MIT
import type { PluginClientApi } from '@babelr/plugin-sdk';

/** Client-only entry for Cass's room (kept apart from manifest.ts so the
 *  server's tsc never traces into JSX). */
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
