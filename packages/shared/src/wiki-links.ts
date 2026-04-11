// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Shared parser for `[[slug]]` wiki refs embedded in markdown content.
 * Used both on the server (to sync wiki_page_links rows after a write)
 * and on the client (to render the refs as clickable links).
 *
 * Syntax supported:
 *   [[page-slug]]              → ref to page with that exact slug
 *   [[Page Title]]             → ref resolved by slugifying the title
 *   [[page-slug|display text]] → ref with custom display text
 *
 * Refs inside fenced or inline code blocks are ignored so people can
 * write about the syntax itself without triggering resolution.
 */

export interface WikiRef {
  /** The slugified target (lowercase, a-z0-9-) */
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
    const slug = slugifyWikiRef(raw);
    if (!slug) continue;
    refs.push({
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
 * Return the deduplicated set of slugs referenced in the source. Order
 * follows first appearance.
 */
export function extractWikiSlugs(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseWikiRefs(source)) {
    if (seen.has(ref.slug)) continue;
    seen.add(ref.slug);
    out.push(ref.slug);
  }
  return out;
}
