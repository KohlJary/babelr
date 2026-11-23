// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for Cass's record (apart from manifest.ts, which reads
 *  its config with node:fs, so the server's tsc never traces into JSX). */
export const clientManifest: PluginManifest = {
  id: 'record',
  name: "Cass's record",
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { RecordView } = await import('./client.js');
  const routeBase = api.routeBase;

  api.registerView({
    id: 'record',
    label: "Cass's record",
    isAvailable: () => false, // opened from the sidebar slot
    render: (props: unknown) => {
      const h = (props as { host: unknown }).host as { closeView: () => void };
      return createElement(RecordView as never, { routeBase, onClose: h.closeView });
    },
  });

  // A door in Cass's room (the column beside her DM), for whoever she shares it with.
  api.registerDaemonSection?.({
    id: 'record',
    label: 'Record',
    icon: '📼',
    order: 20,
    place: 'door',
    isAvailable: async (daemon) => {
      if (daemon.name !== 'cass') return false;
      const r = await fetch(`${routeBase}/configured`, { credentials: 'include' }).catch(
        () => null,
      );
      return !!r?.ok && !!((await r.json()) as { configured?: boolean }).configured;
    },
    open: (props) =>
      (props as { host: { openView: (id: string) => void } }).host.openView('record'),
  });
}
