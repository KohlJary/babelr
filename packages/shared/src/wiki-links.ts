// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Shared parser for `[[...]]` refs embedded in markdown content.
 * Used both on the server (to sync wiki_page_links rows after a
 * write) and on the client (to render the refs as clickable links
 * or embedded previews).
 *
 * Three kinds of ref share the same bracket syntax, distinguished
 * by an optional prefix on the slug:
 *
 *   [[page-slug]]              → wiki page link (no prefix)
 *   [[Page Title]]             → wiki page link (slugified from title)
 *   [[page-slug|display]]      → wiki page link with custom display text
 *   [[msg:abc1234xyz]]         → message embed (renders inline preview)
 *   [[event:abc1234xyz]]       → event embed (renders inline invite card)
 *
 * Refs inside fenced or inline code blocks are ignored so people can
 * write about the syntax itself without triggering resolution.
 */

export type WikiRefKind = 'page' | 'message' | 'event';

export interface WikiRef {
  /** Whether this ref points at a wiki page or a chat message */
  kind: WikiRefKind;
  /**
   * The slugified target. For page refs, lowercase a-z0-9- produced
   * by `slugifyWikiRef`. For message refs, the raw 10-char message
   * slug (lowercase a-z2-9 only — see MESSAGE_SLUG_ALPHABET).
   */
  slug: string;
  /** The raw text inside the brackets, as the user wrote it */
  raw: string;
  /** Display text to render — either the custom text after `|` or the raw */
  display: string;
  /** Character offset of the opening `[[` in the source string */
  start: number;
  /** Character offset immediately after the closing `]]` */
  end: number;
}

const MESSAGE_REF_PREFIX = 'msg:';
const EVENT_REF_PREFIX = 'event:';

/**
 * Turn a title or slug fragment into the canonical slug form we store
 * in the wiki_pages table. Must match the server's `slugify` helper.
 */
export function slugifyWikiRef(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/**
 * Mask out code spans and fenced code blocks so the wiki-ref regex
 * doesn't pick up refs written inside code samples. We replace each
 * masked region with an equal-length run of spaces so character offsets
 * stay aligned with the original source.
 */
function maskCode(source: string): string {
  let out = source;
  // Fenced code blocks: ```...```
  out = out.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
  // Inline code: `...`
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

const WIKI_REF_RE = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

export function parseWikiRefs(source: string): WikiRef[] {
  if (!source) return [];
  const masked = maskCode(source);
  const refs: WikiRef[] = [];
  let match: RegExpExecArray | null;
  WIKI_REF_RE.lastIndex = 0;
  while ((match = WIKI_REF_RE.exec(masked)) !== null) {
    const raw = match[1].trim();
    const display = (match[2] ?? match[1]).trim();

    // Message refs carry a `msg:` prefix that marks them as a
    // different kind — they render as inline embeds rather than
    // navigation links. Strip the prefix from the stored slug so
    // downstream code just works with the message id.
    if (raw.toLowerCase().startsWith(MESSAGE_REF_PREFIX)) {
      const messageSlug = raw.slice(MESSAGE_REF_PREFIX.length).trim().toLowerCase();
      if (!messageSlug) continue;
      refs.push({
        kind: 'message',
        slug: messageSlug,
        raw,
        display,
        start: match.index,
        end: match.index + match[0].length,
      });
      continue;
    }

    // Event refs carry an `event:` prefix. Same substitution model
    // as message refs — render as an inline invite card component.
    if (raw.toLowerCase().startsWith(EVENT_REF_PREFIX)) {
      const eventSlug = raw.slice(EVENT_REF_PREFIX.length).trim().toLowerCase();
      if (!eventSlug) continue;
      refs.push({
        kind: 'event',
        slug: eventSlug,
        raw,
        display,
        start: match.index,
        end: match.index + match[0].length,
      });
      continue;
    }

    const slug = slugifyWikiRef(raw);
    if (!slug) continue;
    refs.push({
      kind: 'page',
      slug,
      raw,
      display,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return refs;
}

/**
 * Return the deduplicated set of page slugs referenced in the
 * source. Message refs are excluded — use `extractMessageSlugs`
 * for those. Order follows first appearance.
 */
export function extractWikiSlugs(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseWikiRefs(source)) {
    if (ref.kind !== 'page') continue;
    if (seen.has(ref.slug)) continue;
    seen.add(ref.slug);
    out.push(ref.slug);
  }
  return out;
}

/**
 * Return the deduplicated set of message slugs referenced in the
 * source. Page refs are excluded. Order follows first appearance.
 */
export function extractMessageSlugs(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseWikiRefs(source)) {
    if (ref.kind !== 'message') continue;
    if (seen.has(ref.slug)) continue;
    seen.add(ref.slug);
    out.push(ref.slug);
  }
  return out;
}

/**
 * Return the deduplicated set of event slugs referenced in the
 * source. Other kinds are excluded. Order follows first appearance.
 */
export function extractEventSlugs(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseWikiRefs(source)) {
    if (ref.kind !== 'event') continue;
    if (seen.has(ref.slug)) continue;
    seen.add(ref.slug);
    out.push(ref.slug);
  }
  return out;
}
