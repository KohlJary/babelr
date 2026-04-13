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
 * Rewrite `[[slug|display]]` refs to markdown link form. Two kinds:
 *
 *   - **Wiki page refs** become `[display](#wiki/<slug>)`. A global
 *     click handler on the chat view intercepts the navigation and
 *     opens the WikiPanel at the target slug.
 *
 *   - **Message refs** (prefix `msg:`) become `[display](#msg/<slug>)`.
 *     The post-processing render step scans for these anchors and
 *     replaces each one with a `<MessageEmbed>` component that
 *     fetches the message and renders a preview inline.
 *
 * Both use the `#foo/bar` fragment style so DOMPurify's default URL
 * scheme checks don't strip the href and the browser doesn't try to
 * navigate on its own.
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
    // Escape pipe and brackets in display text to avoid breaking
    // marked's link syntax. Backticks are left alone since inline
    // code wouldn't have been parsed as a ref in the first place.
    const safeDisplay = ref.display.replace(/[[\]]/g, '\\$&');
    const prefix = ref.kind === 'message' ? '#msg/' : '#wiki/';
    out += `[${safeDisplay}](${prefix}${ref.slug})`;
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
/**
 * Slugify a heading text into an anchor ID. Lowercase, strip
 * non-alphanumeric, collapse to hyphens.
 */
function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function renderWikiMarkdown(content: string): string {
  // Create a custom renderer that adds id attributes to headings
  // for table-of-contents anchor linking.
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const id = headingId(text);
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };

  const raw = marked.parse(preprocessWikiRefs(content), { async: false, renderer }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'a', 'span',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'title', 'id'],
  });
}

/**
 * Extract heading structure from markdown source for rendering
 * a table of contents. Returns an array of { level, text, id }
 * objects in document order.
 */
export function extractHeadings(
  markdown: string,
): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const text = m[2].trim();
    headings.push({
      level: m[1].length,
      text,
      id: headingId(text),
    });
  }
  return headings;
}
