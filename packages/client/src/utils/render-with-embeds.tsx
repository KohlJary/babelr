// SPDX-License-Identifier: Hippocratic-3.0
import { createElement, type ReactNode } from 'react';
import type { ActorProfile, WikiRefKind } from '@babelr/shared';
import { parseWikiRefs } from '@babelr/shared';
import { CrossTowerEmbed } from '../components/CrossTowerEmbed';
import { renderMarkdown, renderWikiMarkdown } from './markdown';
import { getEmbed } from '../embeds/registry';

interface RenderOptions {
  variant: 'chat' | 'wiki';
  /** Single click handler for any inline embed. The host opens its
   *  embed sidebar with this kind+slug. Cross-tower refs render via
   *  CrossTowerEmbed regardless. */
  onPreviewEmbed?: (kind: WikiRefKind, slug: string, serverSlug?: string) => void;
  /** Actor passed to embeds that need it (e.g. image lightbox fallback). */
  actor?: ActorProfile;
}

export function renderWithEmbeds(source: string, opts: RenderOptions): ReactNode {
  const render = opts.variant === 'wiki' ? renderWikiMarkdown : renderMarkdown;
  // Anything NOT a bare wiki page ref is embed-rendered. Page refs
  // render as markdown links (with the wiki-click intercept opening
  // the sidebar preview). Plugin-supplied kinds pass the filter and
  // dispatch through the registry just like built-ins.
  const refs = parseWikiRefs(source).filter(
    (r) => r.kind !== 'page' || r.origin || r.server,
  );

  if (refs.length === 0) {
    return <span dangerouslySetInnerHTML={{ __html: render(source) }} />;
  }

  const segments: ReactNode[] = [];
  let cursor = 0;
  refs.forEach((ref, i) => {
    if (ref.start > cursor) {
      const chunk = source.slice(cursor, ref.start);
      segments.push(
        <span key={`md-${i}`} dangerouslySetInnerHTML={{ __html: render(chunk) }} />,
      );
    }
    if (ref.origin) {
      segments.push(
        <CrossTowerEmbed
          key={`xt-${i}-${ref.slug}`}
          kind={ref.kind}
          slug={ref.slug}
          origin={ref.origin}
        />,
      );
    } else {
      const def = getEmbed(ref.kind);
      if (def) {
        segments.push(
          <span key={`embed-${i}-${ref.kind}-${ref.slug}`}>
            {createElement(def.Inline, {
              slug: ref.slug,
              serverSlug: ref.server,
              onClick: () =>
                opts.onPreviewEmbed?.(ref.kind, ref.slug, ref.server),
              actor: opts.actor,
            })}
          </span>,
        );
      }
    }
    cursor = ref.end;
  });
  if (cursor < source.length) {
    const tail = source.slice(cursor);
    segments.push(
      <span key="md-tail" dangerouslySetInnerHTML={{ __html: render(tail) }} />,
    );
  }
  return <>{segments}</>;
}
