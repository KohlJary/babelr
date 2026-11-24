// SPDX-License-Identifier: MIT
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/** Client-only entry for the Daybook (manifest.ts reads config with node:fs). */
export const clientManifest: PluginManifest = {
  id: 'daybook',
  name: 'Daybook',
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { DaybookView } = await import('./client.js');
  const routeBase = api.routeBase;
  // A house plugin: listed under HOUSE in the House, and in every server.
  // Whatever you click in the Daybook opens here, in the right sidebar (shelf.tsx).
  const { DaybookPreview } = await import('./shelf.js');
  api.registerEmbed({
    kind: 'daybook',
    label: 'Daybook',
    navigateLabel: 'Open the Daybook',
    renderInline: () => null,
    renderPreview: (props: unknown) =>
      createElement(DaybookPreview as never, { slug: (props as { slug: string }).slug }),
    navigate: (_target, ctx) => (ctx as { openView: (id: string) => void }).openView('daybook'),
  });

  api.registerView({
    id: 'daybook',
    label: 'Daybook',
    icon: '📅',
    everywhere: true,
    isAvailable: () => true,
    render: (props: unknown) => {
      const h = (props as { host: unknown }).host as {
        closeView: () => void;
        openEmbedPreview?: (kind: string, slug: string) => void;
      };
      return createElement(DaybookView as never, {
        routeBase,
        onClose: h.closeView,
        openPreview: h.openEmbedPreview
          ? (slug: string) => h.openEmbedPreview!('daybook', slug)
          : undefined,
      });
    },
  });
}
