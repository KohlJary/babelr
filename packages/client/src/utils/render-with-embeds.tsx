// SPDX-License-Identifier: Hippocratic-3.0
import type { ReactNode } from 'react';
import type { EventEmbedView, MessageEmbedView } from '@babelr/shared';
import { parseWikiRefs } from '@babelr/shared';
import { MessageEmbed } from '../components/MessageEmbed';
import { EventEmbed } from '../components/EventEmbed';
import { renderMarkdown, renderWikiMarkdown } from './markdown';

/**
 * Render a markdown string with inline `<MessageEmbed>` and
 * `<EventEmbed>` components substituted for `[[msg:slug]]` and
 * `[[event:slug]]` references.
 *
 * Strategy: parse the raw content for embeddable refs (message +
 * event kinds), split on them, render each surrounding chunk through
 * the normal markdown pipeline (which still preprocesses page refs
 * inside the chunk), and interleave embed components between chunks.
 * The result is a React fragment — safe to drop into any container.
 *
 * When an embed sits inside a paragraph, the surrounding paragraph
 * is split into two `<p>` blocks with the embed between them. That's
 * acceptable because embeds are visually block-level anyway. Users
 * who want clean layout should put embeds on their own line.
 *
 * If there are no embeddable refs, returns a single
 * `dangerouslySetInnerHTML` span with the fully-rendered markdown
 * — same shape and perf as the old path.
 */

interface RenderOptions {
  /** Which markdown renderer to use. Wiki pages use the richer allowlist. */
  variant: 'chat' | 'wiki';
  onNavigateMessage?: (embed: MessageEmbedView) => void;
  onNavigateEvent?: (embed: EventEmbedView) => void;
}

export function renderWithEmbeds(source: string, opts: RenderOptions): ReactNode {
  const render = opts.variant === 'wiki' ? renderWikiMarkdown : renderMarkdown;
  const refs = parseWikiRefs(source).filter(
    (r) => r.kind === 'message' || r.kind === 'event',
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
    if (ref.kind === 'event') {
      segments.push(
        <EventEmbed
          key={`event-${i}-${ref.slug}`}
          slug={ref.slug}
          onNavigate={opts.onNavigateEvent}
        />,
      );
    } else {
      segments.push(
        <MessageEmbed
          key={`msg-${i}-${ref.slug}`}
          slug={ref.slug}
          onNavigate={opts.onNavigateMessage}
        />,
      );
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
