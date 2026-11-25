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
  const setWaiting = (next: boolean) => {
    if (next === waiting) return;
    waiting = next;
    api.availabilityChanged?.();
  };
  // Listed while something's waiting on you. Re-checked each minute so
  // a new draft shows the entry without a reload. Only while signed in:
  // this runs at page load, and fetching before the session is known
  // got a 401 and hid the entry until the next check.
  const check = () =>
    fetchInbox(routeBase).then(
      (items) => setWaiting(items.length > 0),
      () => {},
    );
  let timer: ReturnType<typeof setInterval> | undefined;
  const onSession = (signedIn: boolean) => {
    clearInterval(timer);
    timer = undefined;
    if (!signedIn) {
      setWaiting(false);
      return;
    }
    void check();
    timer = setInterval(() => void check(), 60_000);
  };
  if (api.session) api.session.onChange(onSession);
  else onSession(true);

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
