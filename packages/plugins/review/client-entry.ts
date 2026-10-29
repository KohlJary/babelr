// SPDX-License-Identifier: MIT
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the review plugin (same split as polls).
 * Registers the `review` view: in the sidebar (servers and DMs alike)
 * while something's waiting on you.
 */
export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { ReviewView, fetchInbox } = await import('./client.js');
  const routeBase = api.routeBase;
  let waiting = false;
  // Listed while something's waiting on you. Re-checked each minute so
  // a new draft shows the entry without a reload (it appears on the
  // sidebar's next render).
  const check = () =>
    fetchInbox(routeBase).then(
      (items) => {
        waiting = items.length > 0;
      },
      () => {},
    );
  void check();
  setInterval(() => void check(), 60_000);

  api.registerView({
    id: 'review',
    label: 'Review',
    icon: '📝',
    everywhere: true,
    isAvailable: () => waiting,
    render: (props) => {
      const host = props.host as { closeView: () => void };
      return createElement(ReviewView as never, { routeBase, onClose: host.closeView });
    },
  });
}
