// SPDX-License-Identifier: Hippocratic-3.0
import type { ReactNode } from 'react';
import type { MessageEmbedView } from '@babelr/shared';
import { parseWikiRefs } from '@babelr/shared';
import { MessageEmbed } from '../components/MessageEmbed';
import { renderMarkdown, renderWikiMarkdown } from './markdown';

/**
 * Render a markdown string with inline `<MessageEmbed>` components
 * substituted for `[[msg:slug]]` references.
 *
 * Strategy: parse the raw content for message refs, split on them,
 * render each surrounding chunk through the normal markdown
 * pipeline (which will still preprocess page refs inside the
 * chunk), and interleave `<MessageEmbed>` components between
 * chunks. The result is a React fragment — safe to drop into any
 * container.
 *
 * When a message ref sits inside a paragraph, the surrounding
 * paragraph is split into two `<p>` blocks with the embed between
 * them. That's acceptable because the embed is visually a block-
 * level element anyway. Users who want clean layout should put
 * message embeds on their own line.
 *
 * If there are no message refs, returns a single
 * `dangerouslySetInnerHTML` span with the fully-rendered markdown
 * — same shape and perf as the old path.
 */

interface RenderOptions {
  /** Which markdown renderer to use. Wiki pages use the richer allowlist. */
  variant: 'chat' | 'wiki';
  onNavigateMessage?: (embed: MessageEmbedView) => void;
}

export function renderWithEmbeds(source: string, opts: RenderOptions): ReactNode {
  const render = opts.variant === 'wiki' ? renderWikiMarkdown : renderMarkdown;
  const refs = parseWikiRefs(source).filter((r) => r.kind === 'message');

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
    segments.push(
      <MessageEmbed key={`embed-${i}-${ref.slug}`} slug={ref.slug} onNavigate={opts.onNavigateMessage} />,
    );
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
