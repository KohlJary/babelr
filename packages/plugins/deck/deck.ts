// SPDX-License-Identifier: MIT

/**
 * The deck format, shared by the server (which stores and serves decks)
 * and the client (which shows them). No imports: both sides load it.
 *
 * A deck is Markdown. Slides are separated by a line holding only `---`
 * (a `---` inside a fenced code block doesn't count). Each slide's first
 * `# Title` line is its title; everything else is its body: paragraphs,
 * lists, images (`![alt](https://...)` or a Babelr upload `/uploads/...`)
 * and quotes. Empty slides (two separators in a row) are skipped.
 */

export interface Slide {
  /** 1-based, as people count them ("3 / 7"). */
  n: number;
  /** The slide's `# Title`, or '' if it has none. */
  title: string;
  /** The slide's Markdown without its title line. */
  body: string;
}

export const LIMITS = {
  markdown: 100_000,
  slides: 100,
  title: 200,
  presenters: 10,
  viewers: 100,
} as const;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SEPARATOR_RE = /^---[ \t]*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const TITLE_RE = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function parseSlides(markdown: string): Slide[] {
  const chunks: string[][] = [[]];
  let fence: string | null = null;
  for (const line of (markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE_RE.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    if (fence === null && SEPARATOR_RE.test(line)) {
      chunks.push([]);
      continue;
    }
    chunks[chunks.length - 1].push(line);
  }
  const slides: Slide[] = [];
  for (const lines of chunks) {
    if (!lines.join('').trim()) continue;
    const i = lines.findIndex((l) => l.trim() !== '');
    const m = TITLE_RE.exec(lines[i].trim());
    const title = m ? m[1].trim() : '';
    const body = (m ? lines.slice(i + 1) : lines).join('\n').trim();
    slides.push({ n: slides.length + 1, title, body });
  }
  return slides;
}

/** A slug from a title: lowercase a-z0-9 and hyphens. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** `[[deck:slug]]` / `[[deck:slug#3]]` refs arrive as the slug text
 *  `slug` / `slug#3`. Null when it isn't one. */
export function parseRef(ref: string): { slug: string; n: number | null } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,63})(?:#(\d{1,3}))?$/.exec(ref.trim().toLowerCase());
  if (!m) return null;
  return { slug: m[1], n: m[2] ? Number(m[2]) : null };
}

/** The reference a question about slide `n` starts with. */
export function refFor(slug: string, n?: number | null): string {
  return n ? `[[deck:${slug}#${n}]]` : `[[deck:${slug}]]`;
}

/** Normalize a handle a person typed: no `@`, lowercase, trimmed. */
export function cleanHandle(h: string): string {
  return h.trim().replace(/^@/, '').toLowerCase();
}

export interface DeckPerson {
  id: string;
  handle: string;
  displayName: string | null;
}

export interface DeckSummary {
  slug: string;
  title: string;
  serverId: string;
  slideCount: number;
  presenters: DeckPerson[];
  updatedAt: string;
  canEdit: boolean;
}

export interface DeckPayload extends DeckSummary {
  markdown: string;
  slides: Slide[];
  createdBy: DeckPerson;
  createdAt: string;
  /** Only for those who can edit (the creator and presenters). */
  viewers?: DeckPerson[];
}

/** What an embed shows: titles only, never slide bodies. */
export interface DeckCard {
  slug: string;
  title: string;
  slideCount: number;
  slides: Array<{ n: number; title: string }>;
}
