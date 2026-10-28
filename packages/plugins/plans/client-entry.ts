// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the plans plugin (same split as polls).
 * Registers the `plans` view, listed in the sidebar in servers and DMs
 * alike (plans span the house, and approvals wait on whoever is in DMs),
 * and the `plan` embed: [[plan:slug]] in any message.
 */
export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { PlansView, PlanInline, PlanPreview } = await import('./client.js');
  const routeBase = api.routeBase;

  // [[plan:slug]]: a plan card anywhere a message can link, the way
  // polls, tasks and wiki pages do. Click opens the plan in the view.
  const InlineBound = (props: unknown) =>
    createElement(PlanInline as never, { ...(props as Record<string, unknown>), routeBase });
  const PreviewBound = (props: unknown) =>
    createElement(PlanPreview as never, { ...(props as Record<string, unknown>), routeBase });
  api.registerEmbed({
    kind: 'plan',
    label: 'Plan',
    navigateLabel: 'Open plan',
    renderInline: InlineBound,
    renderPreview: PreviewBound,
    navigate: ({ slug }, ctx) => {
      (ctx as { openView: (id: string, state?: Record<string, unknown>) => void }).openView(
        'plans',
        {
          slug,
        },
      );
    },
  });

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
        initialSlug: (props.viewState?.slug as string | undefined) ?? null,
      });
    },
  });
}
