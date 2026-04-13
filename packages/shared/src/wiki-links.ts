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

export type WikiRefKind = 'page' | 'message' | 'event' | 'file' | 'image' | 'manual';

/**
 * Cross-tower origin for [[server@tower:kind:slug]] refs. When
 * present, the embed resolves via the federation proxy instead
 * of locally.
 */
export interface WikiRefOrigin {
  /** The server (Group) handle, e.g. "test-server" */
  server: string;
  /** The tower hostname, e.g. "partner.com" */
  tower: string;
}

export interface WikiRef {
  /** Whether this ref points at a wiki page, message, event, or file */
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
  /**
   * Cross-tower origin. Present when the ref uses the
   * [[server@tower:kind:slug]] syntax to address content on a
   * remote tower. Absent for local refs.
   */
  origin?: WikiRefOrigin;
  /**
   * Cross-server within the same tower. Present when the ref uses
   * [[server:kind:slug]] syntax to address content in a different
   * server on the same Tower instance. Absent for same-server refs.
   */
  server?: string;
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

/**
 * Map from prefix string to WikiRefKind. Used for both local refs
 * ([[kind:slug]]) and cross-tower refs ([[server@tower:kind:slug]]).
 */
const KIND_PREFIXES: Record<string, WikiRefKind> = {
  'msg:': 'message',
  'event:': 'event',
  'file:': 'file',
  'img:': 'image',
  'wiki:': 'page',
  'man:': 'manual',
};

/**
 * Regex for the cross-tower addressing syntax:
 *   server@tower:kind:slug
 * Captures: [1]=server, [2]=tower, [3]=kind (with trailing colon), [4]=slug
 */
const CROSS_TOWER_RE = /^([^@\s]+)@([^:\s]+):(\w+:)(.+)$/;

/**
 * Regex for the cross-server (same tower) addressing syntax:
 *   server:kind:slug
 * Captures: [1]=server, [2]=kind (with trailing colon), [3]=slug
 *
 * Disambiguated from plain [[kind:slug]] by requiring the server
 * portion to NOT match a known kind prefix. This means a server
 * named "msg" would collide — unlikely in practice.
 */
const CROSS_SERVER_RE = /^([^:@\s]+):(\w+:)(.+)$/;

export function parseWikiRefs(source: string): WikiRef[] {
  if (!source) return [];
  const masked = maskCode(source);
  const refs: WikiRef[] = [];
  let match: RegExpExecArray | null;
  WIKI_REF_RE.lastIndex = 0;
  while ((match = WIKI_REF_RE.exec(masked)) !== null) {
    const raw = match[1].trim();
    const display = (match[2] ?? match[1]).trim();
    const start = match.index;
    const end = match.index + match[0].length;

    // --- Cross-tower refs: [[server@tower:kind:slug]] ---
    const crossMatch = CROSS_TOWER_RE.exec(raw);
    if (crossMatch) {
      const [, server, tower, kindPrefix, slug] = crossMatch;
      const kindKey = kindPrefix.toLowerCase() as string;
      const kind = KIND_PREFIXES[kindKey];
      if (kind && slug.trim()) {
        const resolvedSlug = kind === 'page'
          ? slugifyWikiRef(slug.trim())
          : slug.trim().toLowerCase();
        if (resolvedSlug) {
          refs.push({
            kind,
            slug: resolvedSlug,
            raw,
            display,
            start,
            end,
            origin: { server, tower },
          });
        }
      }
      continue;
    }

    // --- Cross-server refs (same tower): [[server:kind:slug]] ---
    const serverMatch = CROSS_SERVER_RE.exec(raw);
    if (serverMatch) {
      const [, server, kindPrefix, slug] = serverMatch;
      const kindKey = kindPrefix.toLowerCase() as string;
      const kind = KIND_PREFIXES[kindKey];
      // Only treat as cross-server if the first segment isn't itself a
      // known kind prefix (e.g. [[wiki:slug]] should remain a local ref,
      // not server="wiki" kind=slug).
      if (kind && slug.trim() && !KIND_PREFIXES[server.toLowerCase() + ':']) {
        const resolvedSlug = kind === 'page'
          ? slugifyWikiRef(slug.trim())
          : slug.trim().toLowerCase();
        if (resolvedSlug) {
          refs.push({
            kind,
            slug: resolvedSlug,
            raw,
            display,
            start,
            end,
            server: server.toLowerCase(),
          });
          continue;
        }
      }
    }

    // --- Local refs with explicit kind prefix ---
    const lowerRaw = raw.toLowerCase();
    let handled = false;
    for (const [prefix, kind] of Object.entries(KIND_PREFIXES)) {
      if (lowerRaw.startsWith(prefix)) {
        const slug = raw.slice(prefix.length).trim().toLowerCase();
        if (!slug) break;
        const resolvedSlug = kind === 'page' ? slugifyWikiRef(slug) : slug;
        if (!resolvedSlug) break;
        refs.push({ kind, slug: resolvedSlug, raw, display, start, end });
        handled = true;
        break;
      }
    }
    if (handled) continue;

    // --- Bare [[slug]] — backwards-compatible wiki page ref ---
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

/**
 * Return the deduplicated set of file slugs referenced in the
 * source. Other kinds are excluded. Order follows first appearance.
 */
export function extractFileSlugs(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseWikiRefs(source)) {
    if (ref.kind !== 'file') continue;
    if (seen.has(ref.slug)) continue;
    seen.add(ref.slug);
    out.push(ref.slug);
  }
  return out;
}
