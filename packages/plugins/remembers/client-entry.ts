// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry (manifest.ts reads its config with node:fs). */
export const clientManifest: PluginManifest = {
  id: 'remembers',
  name: 'What she remembers about you',
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { RemembersYou, memoryDaemons } = await import('./client.js');
  const routeBase = api.routeBase;
  // In her room, beside your DM with her: what she keeps about you.
  api.registerDaemonSection?.({
    id: 'remembers',
    label: 'About you',
    icon: '🫧',
    order: 20,
    place: 'section',
    isAvailable: async (daemon) =>
      (await memoryDaemons(routeBase)).includes(daemon.name.toLowerCase()),
    render: (props: unknown) =>
      createElement(RemembersYou as never, { ...(props as Record<string, unknown>), routeBase }),
  });
}
