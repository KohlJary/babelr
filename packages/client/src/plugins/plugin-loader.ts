// SPDX-License-Identifier: Hippocratic-3.0
import type {
  PluginClientApi,
  ClientEmbedDefinition,
  ClientViewDefinition,
} from '@babelr/plugin-sdk';
import { registerEmbed, type EmbedDefinition } from '../embeds/registry';
import { registerView, type ViewDefinition } from '../views/registry';
import { registeredPlugins } from './registered';

/**
 * Client-side plugin boot. Runs once at app startup after the built-in
 * embed and view registrations. Each plugin's manifest.setupClient() is
 * handed a `PluginClientApi` wired to the real registries, and gets a
 * chance to call registerEmbed / registerView for its own kinds and
 * views.
 *
 * Plugins that fail to load don't break the app — the error is logged
 * and the plugin's registrations (if any ran partially) are what they
 * are. Because registerEmbed is last-write-wins, a failed plugin at
 * worst leaves a partial state for its own kind.
 */
export async function initPlugins(): Promise<void> {
  for (const manifest of registeredPlugins) {
    if (!manifest.setupClient) continue;
    const api: PluginClientApi = {
      registerEmbed: (def: ClientEmbedDefinition) => {
        // Plugin-author types are intentionally loose to avoid forcing
        // React into the SDK. At the registration boundary we cast back
        // to the strict client-side shape; if the plugin author got the
        // contract wrong, errors surface at render time, same as any
        // first-party mis-registration would.
        registerEmbed(def as unknown as EmbedDefinition);
      },
      registerView: (def: ClientViewDefinition) => {
        registerView(def as unknown as ViewDefinition);
      },
      routeBase: `/api/plugins/${manifest.id}`,
    };
    try {
      await manifest.setupClient(api);
    } catch (err) {
      console.error(`[plugin:${manifest.id}] setupClient failed:`, err);
    }
  }
}
