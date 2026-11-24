// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for Cass's room (kept apart from manifest.ts so the
 *  server's tsc never traces into JSX). */
/** Browser-safe manifest: manifest.ts reads its config with node:fs, so
 *  the client takes this one instead (as blinds does). */
export const clientManifest: PluginManifest = {
  id: 'room',
  name: 'Rooms',
  version: '0.2.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { RoomView } = await import('./client.js');
  const routeBase = api.routeBase;

  // Each daemon's room lives under /d/<name> (Cass's at the old paths too).
  const base = (name: string) => `${routeBase}/d/${encodeURIComponent(name)}`;

  api.registerView({
    id: 'room',
    label: 'Room',
    isAvailable: () => false, // opened from a daemon's door
    render: (props: unknown) => {
      const p = props as { host: { closeView: () => void }; viewState?: Record<string, unknown> };
      const name = typeof p.viewState?.daemon === 'string' ? p.viewState.daemon : 'cass';
      const who =
        typeof p.viewState?.label === 'string'
          ? p.viewState.label
          : name === 'cass'
            ? 'Cass'
            : name;
      return createElement(RoomView as never, {
        key: name,
        routeBase: base(name),
        who,
        onClose: p.host.closeView,
      });
    },
  });

  // A door in each daemon's room (the column beside her DM), not a server-sidebar
  // entry (Kohl, 2026-11-23: daemon plugins live with the daemon). Shown only to
  // someone her vessel minted a token for (Kohl, 2026-11-24: every daemon).
  api.registerDaemonSection?.({
    id: 'room',
    label: 'Room',
    icon: '🖼️',
    order: 5,
    place: 'door',
    isAvailable: async (daemon) => {
      const r = await fetch(`${base(daemon.name)}/configured`, { credentials: 'include' }).catch(
        () => null,
      );
      return !!r?.ok && !!((await r.json()) as { configured?: boolean }).configured;
    },
    open: (props) => {
      const p = props as {
        daemon?: { name: string; label?: string };
        host: { openView: (id: string, state?: Record<string, unknown>) => void };
      };
      const name = p.daemon?.name ?? 'cass';
      p.host.openView('room', { daemon: name, label: p.daemon?.label ?? name });
    },
  });
}
