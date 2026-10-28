// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the plans plugin (same split as polls).
 * Registers the `plans` view, listed in the sidebar in servers and DMs
 * alike: plans span the house, and approvals wait on whoever is in DMs.
 */
export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { PlansView } = await import('./client.js');
  const routeBase = api.routeBase;

  api.registerView({
    id: 'plans',
    label: 'Plans',
    icon: '🗺️',
    everywhere: true,
    isAvailable: () => true,
    render: (props) => {
      const host = props.host as {
        closeView: () => void;
        selectedServer: { id: string; name: string } | null;
      };
      return createElement(PlansView as never, {
        routeBase,
        onClose: host.closeView,
        serverId: host.selectedServer?.id ?? null,
      });
    },
  });
}
