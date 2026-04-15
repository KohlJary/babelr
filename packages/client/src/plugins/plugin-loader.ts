// SPDX-License-Identifier: Hippocratic-3.0
import type {
  PluginClientApi,
  ClientEmbedDefinition,
  ClientViewDefinition,
  ClientSidebarSlotDefinition,
} from '@babelr/plugin-sdk';
import { registerEmbed, type EmbedDefinition } from '../embeds/registry';
import { registerView, type ViewDefinition } from '../views/registry';
import { registerSidebarSlot, type SidebarSlotDefinition } from './sidebar-registry';
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
  for (const entry of registeredPlugins) {
    const { manifest } = entry;
    // Prefer the client-entry-provided setupClient; fall back to the
    // manifest's own (for plugins that keep everything in one file).
    const setup = entry.setupClient ?? manifest.setupClient;
    if (!setup) continue;
    const api: PluginClientApi = {
      registerEmbed: (def: ClientEmbedDefinition) => {
        // The SDK's loose types (props: unknown) -> unknown map 1:1 to
        // component functions that return ReactNode. Cast to the
        // client's strict ComponentType shape — shapes are compatible,
        // TS just needs the coercion.
        registerEmbed({
          kind: def.kind,
          label: def.label,
          navigateLabel: def.navigateLabel,
          Inline: def.renderInline as unknown as EmbedDefinition['Inline'],
          Preview: def.renderPreview as unknown as EmbedDefinition['Preview'],
          navigate: def.navigate as unknown as EmbedDefinition['navigate'],
        });
      },
      registerView: (def: ClientViewDefinition) => {
        registerView({
          id: def.id,
          label: def.label,
          icon: def.icon as ViewDefinition['icon'],
          isAvailable: def.isAvailable as ViewDefinition['isAvailable'],
          View: def.render as unknown as ViewDefinition['View'],
        });
      },
      registerSidebarSlot: (def: ClientSidebarSlotDefinition) => {
        // Wrap the plugin's Component so the sidebar host context it
        // receives has THIS plugin's routeBase, not the generic one
        // ChatView passes. Each plugin registers its own slot with its
        // own namespaced API path.
        const pluginRouteBase = `/api/plugins/${manifest.id}`;
        const OriginalComponent = def.Component as (props: {
          host: unknown;
        }) => unknown;
        const wrapped = (({ host }: { host: unknown }) => {
          const pluginHost = {
            ...(host as Record<string, unknown>),
            routeBase: pluginRouteBase,
          };
          return OriginalComponent({ host: pluginHost });
        }) as unknown as SidebarSlotDefinition['Component'];
        registerSidebarSlot({
          id: def.id,
          Component: wrapped,
          isAvailable: def.isAvailable as SidebarSlotDefinition['isAvailable'],
        });
      },
      routeBase: `/api/plugins/${manifest.id}`,
    };
    try {
      await setup(api);
    } catch (err) {
      console.error(`[plugin:${manifest.id}] setupClient failed:`, err);
    }
  }
}
