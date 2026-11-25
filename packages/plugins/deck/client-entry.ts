// SPDX-License-Identifier: MIT
import type { PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Client-only entry for the deck plugin (same split as polls).
 *
 * Registers:
 *   - embed `deck`: [[deck:slug]] and [[deck:slug#n]]. A card with the
 *     deck's and the slide's titles; tapping it opens the deck at that
 *     slide. Anyone who isn't a viewer sees "a private deck".
 *   - view `deck`: "Decks" in the sidebar, servers and DMs alike, while
 *     you can see at least one deck (or are an admin of the server
 *     you're in, so there's somewhere to make the first one). Opened
 *     at a slide by viewState { slug, n }, from a card or /deck/<slug>.
 */
export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { DecksView, DeckInline, DeckPreview, fetchDecks } = await import('./client.js');
  const routeBase = api.routeBase;

  let hasDecks = false;
  const setHas = (next: boolean) => {
    if (next === hasDecks) return;
    hasDecks = next;
    api.availabilityChanged?.();
  };
  const check = () =>
    fetchDecks(routeBase).then(
      (d) => setHas(d.length > 0),
      () => {},
    );
  let timer: ReturnType<typeof setInterval> | undefined;
  const onSession = (signedIn: boolean) => {
    clearInterval(timer);
    timer = undefined;
    if (!signedIn) {
      setHas(false);
      return;
    }
    void check();
    timer = setInterval(() => void check(), 60_000);
  };
  if (api.session) api.session.onChange(onSession);
  else onSession(true);

  const ref = (props: unknown) => (props as { slug: string }).slug;
  api.registerEmbed({
    kind: 'deck',
    label: 'Deck',
    navigateLabel: 'Open the deck',
    renderInline: (props: unknown) =>
      createElement(DeckInline as never, { slug: ref(props), routeBase }),
    renderPreview: (props: unknown) =>
      createElement(DeckPreview as never, {
        slug: ref(props),
        routeBase,
        onNavigate: (props as { onNavigate: () => void }).onNavigate,
      }),
    navigate: ({ slug }, ctx) => {
      const [base, n] = slug.split('#');
      (ctx as { openView: (id: string, state?: Record<string, unknown>) => void }).openView(
        'deck',
        { slug: base, n: Number(n) || 1 },
      );
    },
  });

  api.registerView({
    id: 'deck',
    label: 'Decks',
    icon: '▦',
    everywhere: true,
    isAvailable: (host) =>
      hasDecks || ['owner', 'admin'].includes((host as { callerRole?: string }).callerRole ?? ''),
    render: (props) =>
      createElement(DecksView as never, {
        routeBase,
        host: props.host,
        viewState: props.viewState ?? {},
        dm: api.dm,
        onListChanged: () => void check(),
      }),
  });
}
