// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Split a wiki page's markdown source into an ordered list of chunks
 * suitable for independent translation. The two goals:
 *
 * 1. **Granular caching** — edit one paragraph, don't retranslate the
 *    whole page. Each chunk gets its own cache key via content hash.
 *
 * 2. **Mixed-language support** — a page can have English, Spanish,
 *    and Japanese interleaved; each chunk hits the existing
 *    single-language classifier independently and the detected
 *    language can differ per chunk.
 *
 * A chunk is `{ kind, content, startLine }`:
 *
 * - `kind: 'prose'` — normal paragraph or heading. Sent to the
 *   translator.
 * - `kind: 'code'` — fenced code block. Preserved verbatim; the
 *   translator is never asked to touch it because code has no
 *   natural language to translate.
 * - `kind: 'blank'` — blank-line separator. Kept so reassembly
 *   reproduces the exact original whitespace.
 *
 * The splitter is intentionally simple: it walks line-by-line and
 * switches state on triple-backtick fences and blank lines. It does
 * not try to handle setext-style headings, HTML blocks, or other
 * edge cases — a future PR can layer a real markdown-aware parser on
 * top if coverage becomes a problem.
 */

export type WikiChunkKind = 'prose' | 'code' | 'blank';

export interface WikiChunk {
  kind: WikiChunkKind;
  content: string;
}

const FENCE_RE = /^```/;

export function chunkWikiContent(source: string): WikiChunk[] {
  if (!source) return [];
  const lines = source.split('\n');
  const chunks: WikiChunk[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — swallow until closing fence.
    if (FENCE_RE.test(line)) {
      const codeLines: string[] = [line];
      i += 1;
      while (i < lines.length) {
        codeLines.push(lines[i]);
        if (FENCE_RE.test(lines[i])) {
          i += 1;
          break;
        }
        i += 1;
      }
      chunks.push({ kind: 'code', content: codeLines.join('\n') });
      continue;
    }

    // Blank line — preserve as its own chunk so reassembly is exact.
    if (line.trim() === '') {
      chunks.push({ kind: 'blank', content: '' });
      i += 1;
      continue;
    }

    // Prose paragraph — gather consecutive non-blank, non-fence lines.
    const proseLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !FENCE_RE.test(lines[i])) {
      proseLines.push(lines[i]);
      i += 1;
    }
    chunks.push({ kind: 'prose', content: proseLines.join('\n') });
  }

  return chunks;
}

/**
 * Reassemble a list of chunks back into a single markdown string.
 * Blank chunks emit an empty line; the other kinds emit their
 * content verbatim. Adjacent chunks are separated by a newline so
 * the original line structure is preserved.
 */
export function reassembleWikiChunks(chunks: WikiChunk[]): string {
  return chunks.map((c) => (c.kind === 'blank' ? '' : c.content)).join('\n');
}
