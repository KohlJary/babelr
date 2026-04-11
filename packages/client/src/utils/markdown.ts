// SPDX-License-Identifier: Hippocratic-3.0
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseWikiRefs } from '@babelr/shared';

// Configure marked for chat messages
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Rewrite `[[slug|display]]` refs to markdown link form pointing at an
 * in-app wiki fragment. We use `#wiki/<slug>` so clicks can be
 * intercepted by a global handler without the browser trying to
 * navigate elsewhere, and so DOMPurify's default URL scheme checks
 * don't strip the href.
 *
 * Code spans/fenced blocks are handled by parseWikiRefs — the parser
 * masks them out, so refs inside code samples are left alone.
 */
export function preprocessWikiRefs(source: string): string {
  const refs = parseWikiRefs(source);
  if (refs.length === 0) return source;
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    out += source.slice(cursor, ref.start);
    // Escape pipe and brackets in display text to avoid breaking marked's
    // link syntax. Backticks are left alone since inline code wouldn't
    // have been parsed as a ref in the first place.
    const safeDisplay = ref.display.replace(/[[\]]/g, '\\$&');
    out += `[${safeDisplay}](#wiki/${ref.slug})`;
    cursor = ref.end;
  }
  out += source.slice(cursor);
  return out;
}

export function renderMarkdown(content: string): string {
  const raw = marked.parse(preprocessWikiRefs(content), { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'a', 'span',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });
}

/**
 * Wiki markdown allows the richer tag set that long-form content
 * needs: headings, tables, horizontal rules, and images. Still sanitized
 * through DOMPurify with an explicit allowlist.
 */
export function renderWikiMarkdown(content: string): string {
  const raw = marked.parse(preprocessWikiRefs(content), { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'a', 'span',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'title'],
  });
}
