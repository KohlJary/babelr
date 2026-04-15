// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { definePlugin } from '@babelr/plugin-sdk';

/**
 * Minimal smoke tests for the plugin SDK surface. The real integration
 * testing happens when polls and project-management land as actual
 * plugins — those are the end-to-end validators the phase plan is
 * built around.
 *
 * This file asserts the SDK types are wired and definePlugin behaves
 * as an identity function so future plugin authors can rely on it.
 */

describe('definePlugin', () => {
  it('returns the manifest unchanged (identity helper)', () => {
    const manifest = definePlugin({
      id: 'test-plugin',
      name: 'Test',
      version: '0.1.0',
      dependencies: { babelr: '^0.1.0' },
    });
    expect(manifest.id).toBe('test-plugin');
    expect(manifest.name).toBe('Test');
    expect(manifest.version).toBe('0.1.0');
  });

  it('accepts a full manifest with all optional fields', async () => {
    const manifest = definePlugin({
      id: 'full',
      name: 'Full',
      version: '0.1.0',
      description: 'A plugin with everything wired',
      dependencies: { babelr: '^0.1.0' },
      migrations: [
        {
          id: 1,
          name: 'init',
          up: 'CREATE TABLE plugin_full_items (id SERIAL PRIMARY KEY)',
        },
      ],
      serverRoutes: async () => {
        // no-op
      },
      federationHandlers: {
        full: {
          resolveBySlug: async (slug) => ({ slug, echo: true }),
        },
      },
      setupClient: async () => {
        // no-op
      },
    });
    expect(manifest.migrations?.[0].id).toBe(1);
    expect(manifest.federationHandlers?.full).toBeDefined();
    const result = await manifest.federationHandlers!.full.resolveBySlug('hi', {
      fastify: {} as never,
    });
    expect(result).toEqual({ slug: 'hi', echo: true });
  });
});
