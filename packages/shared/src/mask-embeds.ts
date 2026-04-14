// SPDX-License-Identifier: Hippocratic-3.0
import { parseWikiRefs } from './wiki-links.js';

/**
 * Replace `[[kind:slug]]` embed refs in a string with opaque placeholder
 * tokens before sending the string to a translation engine. The LLM
 * preserves the placeholders verbatim; we restore the original refs
 * afterward. Two reasons:
 *
 *   1. LLMs sometimes translate the slug or rewrite the bracket syntax
 *      ([[ → 「, kind names → translated equivalents, etc.), which
 *      breaks downstream parsing.
 *   2. Embed slugs are identifiers, not natural language — translating
 *      them is meaningless work.
 *
 * Placeholder format: `⟦E0⟧`, `⟦E1⟧`, etc. Mathematical white square
 * brackets are unusual enough to survive most LLM passes, and the
 * regex is unambiguous on the way back. Cross-tower / cross-server
 * refs are masked as a single unit just like local refs.
 */

export interface MaskedEmbeds {
  masked: string;
  /** Raw substrings of the original `[[...]]` refs, in index order. */
  tokens: string[];
}

const PLACEHOLDER = (i: number): string => `\u27E6E${i}\u27E7`;
const RESTORE_RE = /\u27E6E(\d+)\u27E7/g;

export function maskEmbeds(content: string): MaskedEmbeds {
  const refs = parseWikiRefs(content);
  if (refs.length === 0) return { masked: content, tokens: [] };
  let out = '';
  let cursor = 0;
  const tokens: string[] = [];
  refs.forEach((ref, i) => {
    out += content.slice(cursor, ref.start);
    out += PLACEHOLDER(i);
    tokens.push(content.slice(ref.start, ref.end));
    cursor = ref.end;
  });
  out += content.slice(cursor);
  return { masked: out, tokens };
}

export function restoreEmbeds(content: string, tokens: string[]): string {
  return content.replace(RESTORE_RE, (_, n) => tokens[Number(n)] ?? '');
}

/**
 * Split `[[...]]`-aware translation for NMT models (transformers.js,
 * any model not robust enough to preserve placeholder tokens). Splits
 * the content into text + embed alternating segments, runs the
 * translator on each text segment only, and reassembles with the
 * original embed substrings spliced back in.
 *
 * Use this for any provider that doesn't reliably copy ⟦E*⟧ tokens
 * verbatim — small NMT models in particular have no concept of
 * "preserve this token" and will happily mangle the unicode brackets.
 *
 * Empty / whitespace-only segments skip the translator call to avoid
 * wasting model time on nothing.
 */
export async function translatePreservingEmbeds(
  content: string,
  translate: (text: string) => Promise<string>,
): Promise<string> {
  const refs = parseWikiRefs(content);
  if (refs.length === 0) return translate(content);
  let cursor = 0;
  const parts: string[] = [];
  for (const ref of refs) {
    if (ref.start > cursor) {
      const segment = content.slice(cursor, ref.start);
      parts.push(segment.trim() ? await translate(segment) : segment);
    }
    parts.push(content.slice(ref.start, ref.end));
    cursor = ref.end;
  }
  if (cursor < content.length) {
    const tail = content.slice(cursor);
    parts.push(tail.trim() ? await translate(tail) : tail);
  }
  return parts.join('');
}
