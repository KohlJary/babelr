// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the review plugin (same split as polls).
 * Registers the `review` view: in the toolbar when there's something
 * waiting on you (checked once at load).
 */
export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { ReviewView, fetchInbox } = await import('./client.js');
  const routeBase = api.routeBase;
  let waiting = false;
  void fetchInbox(routeBase).then(
    (items) => {
      waiting = items.length > 0;
    },
    () => {},
  );

  api.registerView({
    id: 'review',
    label: 'Review',
    isAvailable: () => waiting,
    render: (props) => {
      const host = props.host as { closeView: () => void };
      return createElement(ReviewView as never, { routeBase, onClose: host.closeView });
    },
  });
}
