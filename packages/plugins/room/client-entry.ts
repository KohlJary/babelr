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
  const { RoomView } = await import('./client.js');
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

  // A door in Cass's room (the column beside her DM), not a server-sidebar entry
  // (Kohl, 2026-11-23: daemon plugins live with the daemon).
  api.registerDaemonSection?.({
    id: 'room',
    label: 'Room',
    icon: '🖼️',
    order: 5,
    place: 'door',
    isAvailable: async (daemon) => {
      if (daemon.name !== 'cass') return false;
      const r = await fetch(`${routeBase}/configured`, { credentials: 'include' }).catch(
        () => null,
      );
      return !!r?.ok && !!((await r.json()) as { configured?: boolean }).configured;
    },
    open: (props) => (props as { host: { openView: (id: string) => void } }).host.openView('room'),
  });
}
