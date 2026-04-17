// SPDX-License-Identifier: Hippocratic-3.0
import type { HighlighterGeneric, BundledLanguage, BundledTheme } from 'shiki';

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;
let highlighterInstance: HighlighterGeneric<BundledLanguage, BundledTheme> | null = null;

const COMMON_LANGS: BundledLanguage[] = [
  'javascript', 'typescript', 'python', 'rust', 'go', 'java',
  'c', 'cpp', 'csharp', 'ruby', 'php', 'swift', 'kotlin',
  'html', 'css', 'json', 'yaml', 'toml', 'sql', 'bash',
  'markdown', 'dockerfile', 'graphql',
];

async function getHighlighter() {
  if (highlighterInstance) return highlighterInstance;
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark'],
        langs: COMMON_LANGS,
      }),
    );
  }
  highlighterInstance = await highlighterPromise;
  return highlighterInstance;
}

/**
 * Highlight a code string. Returns HTML with Shiki's theme tokens.
 * Falls back to plain escaped text if the language isn't loaded or
 * the highlighter hasn't initialized yet.
 */
export async function highlightCode(
  code: string,
  lang: string,
): Promise<string> {
  try {
    const hl = await getHighlighter();
    const loadedLangs = hl.getLoadedLanguages();
    if (!loadedLangs.includes(lang as BundledLanguage)) {
      return escapeHtml(code);
    }
    return hl.codeToHtml(code, {
      lang: lang as BundledLanguage,
      theme: 'github-dark',
    });
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Synchronous highlight attempt — returns highlighted HTML if the
 * highlighter is already loaded, otherwise returns null so the
 * caller can show plain text and upgrade later.
 */
export function highlightCodeSync(
  code: string,
  lang: string,
): string | null {
  if (!highlighterInstance) return null;
  try {
    const loadedLangs = highlighterInstance.getLoadedLanguages();
    if (!loadedLangs.includes(lang as BundledLanguage)) return null;
    return highlighterInstance.codeToHtml(code, {
      lang: lang as BundledLanguage,
      theme: 'github-dark',
    });
  } catch {
    return null;
  }
}

/** Pre-warm the highlighter so first code block renders fast. */
export function preloadHighlighter(): void {
  void getHighlighter();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
