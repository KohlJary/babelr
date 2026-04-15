// SPDX-License-Identifier: Hippocratic-3.0
export * from './types.js';

import type { PluginManifest } from './types.js';

/**
 * Ergonomic helper for writing a manifest with full IntelliSense.
 * Plugin authors write:
 *
 *   export default definePlugin({
 *     id: 'polls',
 *     name: 'Polls & Quizzes',
 *     version: '0.1.0',
 *     dependencies: { babelr: '^0.1.0' },
 *     migrations: [...],
 *     serverRoutes: async (fastify) => { ... },
 *     setupClient: async (api) => { ... },
 *     federationHandlers: { poll: { resolveBySlug: ... } },
 *   });
 *
 * The helper is the identity function at runtime — its job is to pin the
 * type at definition-site so authors don't have to annotate.
 */
export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest;
}
