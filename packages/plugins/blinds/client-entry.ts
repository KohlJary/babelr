// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginClientApi, PluginManifest } from '@babelr/plugin-sdk';

/**
 * Client-only entry point for the blinds plugin, split from
 * manifest.ts for the same reason as polls: the server's tsc pass must
 * never trace into JSX. The client's registered.ts imports this.
 *
 * Registers:
 *   - embed kind `blind`: [[blind:<round>]]. Inline = progress card;
 *     preview = the phone-first grader (one answer at a time).
 *   - view `blinds`: the same grader in the main panel, opened from
 *     the embed sidebar's "Open grader" button.
 */
/**
 * Client-side manifest. Unlike polls, the blinds manifest.ts imports
 * node:fs (it reads bundles off disk), so the browser bundle must not
 * import it. The client only needs the id (for routeBase); keep these
 * fields in sync with manifest.ts.
 */
export const clientManifest: PluginManifest = {
  id: 'blinds',
  name: 'Blinds',
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },
};

export async function setupClient(api: PluginClientApi): Promise<void> {
  const { createElement } = await import('react');
  const { BlindInline, BlindPreview, BlindsView } = await import('./client.js');
  const routeBase = api.routeBase;

  const InlineBound = (props: unknown) =>
    createElement(BlindInline as never, { ...(props as Record<string, unknown>), routeBase });
  const PreviewBound = (props: unknown) =>
    createElement(BlindPreview as never, { ...(props as Record<string, unknown>), routeBase });

  api.registerEmbed({
    kind: 'blind',
    label: 'Blind round',
    navigateLabel: 'Open grader',
    renderInline: InlineBound,
    renderPreview: PreviewBound,
    navigate: ({ slug }, ctx) => {
      (ctx as { openView: (id: string, state?: Record<string, unknown>) => void }).openView(
        'blinds',
        { round: slug },
      );
    },
  });

  api.registerView({
    id: 'blinds',
    label: 'Blinds',
    isAvailable: () => false, // no toolbar entry; opened from the embed
    render: (props) => {
      const host = props.host as { closeView: () => void };
      return createElement(BlindsView as never, {
        round: props.viewState?.round as string | undefined,
        routeBase,
        onClose: host.closeView,
      });
    },
  });
}
