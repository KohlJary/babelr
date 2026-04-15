// SPDX-License-Identifier: Hippocratic-3.0
import { definePlugin } from '@babelr/plugin-sdk';

/**
 * Hello-world reference plugin. Exercises the full plugin surface in
 * the smallest possible way:
 *
 *   - registers a server route (GET /plugins/hello/ping)
 *   - registers a federation handler for `hello:*` that echoes
 *   - registers a `[[hello:name]]` embed kind client-side
 *
 * Install: already in packages/plugins/hello/. Add to
 * packages/server/src/plugins/registered.ts and
 * packages/client/src/plugins/registered.ts to activate.
 *
 * Stays in-tree forever as a reference implementation plugin authors
 * can copy from.
 */
export default definePlugin({
  id: 'hello',
  name: 'Hello World (plugin reference)',
  version: '0.1.0',
  description: 'Reference plugin demonstrating the plugin SDK.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    fastify.get('/ping', async () => ({ pong: true, ts: Date.now() }));
  },

  federationHandlers: {
    hello: {
      resolveBySlug: async (slug) => ({
        slug,
        greeting: `Hello, ${slug}!`,
      }),
    },
  },

  setupClient: async (api) => {
    // Keep React / DOM code inside setupClient via dynamic imports so
    // manifest.ts remains runtime-agnostic (server imports it too).
    const { createElement } = await import('react');

    api.registerEmbed({
      kind: 'hello',
      label: 'Hello embed',
      navigateLabel: 'Show greeting',
      renderInline: (props) => {
        const p = props as { slug: string; onClick: () => void };
        return createElement(
          'button',
          {
            type: 'button',
            className: 'hello-embed',
            onClick: p.onClick,
          },
          `👋 Hello, ${p.slug}!`,
        );
      },
      renderPreview: (props) => {
        const p = props as { slug: string };
        return createElement(
          'div',
          { className: 'hello-preview' },
          `Hello, ${p.slug}! This is the plugin SDK working end-to-end.`,
        );
      },
      navigate: () => {
        // No full-view destination for hello; the preview is the whole
        // experience. The sidebar's "Open in X" button still renders
        // (harmless click).
      },
    });
  },
});
