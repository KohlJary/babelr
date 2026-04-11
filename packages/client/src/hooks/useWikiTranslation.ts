// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useMemo } from 'react';
import { chunkWikiContent, reassembleWikiChunks, type WikiChunk } from '@babelr/shared';
import {
  AnthropicProvider,
  TransformersJsProvider,
  getCachedByHash,
  setCachedByHash,
  hashContent,
  type TranslationProvider,
  type CachedTranslation,
  type TranslationSettings,
} from '../translation';

interface UseWikiTranslationResult {
  /** Fully reassembled translated markdown, or null while still loading */
  translatedContent: string | null;
  /** True if at least one chunk is currently being translated */
  isTranslating: boolean;
  /** Per-chunk detected languages, in chunk order. Only populated for prose chunks. */
  detectedLanguages: string[];
  /** True if any chunk's detected language differs from the target */
  anyTranslated: boolean;
}

/**
 * Translate a wiki page's markdown content, chunk by chunk. Each
 * prose paragraph is hashed and cache-checked independently — so
 * editing one paragraph only retranslates that paragraph, and a page
 * with mixed-language content resolves each chunk's source language
 * on its own.
 *
 * Code-fence chunks and blank lines are passed through verbatim.
 *
 * Returns `translatedContent = null` until the first non-cached batch
 * resolves (or until there's nothing to translate, in which case the
 * original content is returned immediately). The caller should show
 * the original content as a fallback while loading.
 */
export function useWikiTranslation(
  content: string,
  settings: TranslationSettings,
  enabled: boolean,
): UseWikiTranslationResult {
  const providerRef = useRef<TranslationProvider | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());
  const [chunkTranslations, setChunkTranslations] = useState<Map<string, CachedTranslation>>(
    new Map(),
  );
  const [isTranslating, setIsTranslating] = useState(false);

  // Provider reconstruction on settings change — mirrors useTranslation.
  useEffect(() => {
    if (settings.provider === 'local') {
      providerRef.current = new TransformersJsProvider();
    } else if (settings.provider === 'anthropic' && settings.apiKey) {
      providerRef.current = new AnthropicProvider(settings.apiKey);
    } else {
      providerRef.current = null;
    }
  }, [settings.apiKey, settings.provider]);

  const chunks = useMemo<WikiChunk[]>(() => chunkWikiContent(content), [content]);

  // Compute the hash for each prose chunk once. Non-prose chunks get
  // an empty hash since we never translate them.
  const chunkHashes = useMemo(
    () => chunks.map((c) => (c.kind === 'prose' ? hashContent(c.content) : '')),
    [chunks],
  );

  // Fetch uncached chunk translations. Runs whenever the content,
  // target language, or settings change.
  useEffect(() => {
    if (!enabled) return;
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const targetLang = settings.preferredLanguage;
    const uncached: { hash: string; content: string }[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.kind !== 'prose') continue;
      const h = chunkHashes[i];
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const inflightKey = `${h}:${targetLang}`;
      if (inflightRef.current.has(inflightKey)) continue;
      if (getCachedByHash('wiki', h, targetLang)) continue;
      uncached.push({ hash: h, content: c.content });
    }

    if (uncached.length === 0) return;

    for (const u of uncached) inflightRef.current.add(`${u.hash}:${targetLang}`);
    setIsTranslating(true);

    const provider = providerRef.current;
    const batch = uncached.map((u) => ({ id: u.hash, content: u.content }));

    provider
      .translate(batch, targetLang)
      .then((results) => {
        const next = new Map<string, CachedTranslation>();
        for (const r of results) {
          const entry: CachedTranslation = {
            translatedContent: r.translatedContent,
            detectedLanguage: r.detectedLanguage,
            skipped: r.skipped,
            targetLanguage: targetLang,
            metadata: r.metadata,
          };
          setCachedByHash('wiki', r.id, targetLang, entry);
          next.set(r.id, entry);
        }
        setChunkTranslations((prev) => new Map([...prev, ...next]));
        for (const u of uncached) inflightRef.current.delete(`${u.hash}:${targetLang}`);
        setIsTranslating(false);
      })
      .catch((err) => {
        console.error('Wiki translation failed:', err);
        for (const u of uncached) inflightRef.current.delete(`${u.hash}:${targetLang}`);
        setIsTranslating(false);
      });
  }, [
    chunks,
    chunkHashes,
    enabled,
    settings.enabled,
    settings.preferredLanguage,
    settings.apiKey,
    settings.provider,
  ]);

  // Pull the current translation state (memory + localStorage) for
  // every prose chunk, falling back to the original content for chunks
  // that aren't translated yet.
  const { translatedContent, detectedLanguages, anyTranslated } = useMemo(() => {
    if (!enabled || !settings.preferredLanguage) {
      return { translatedContent: null, detectedLanguages: [], anyTranslated: false };
    }
    const targetLang = settings.preferredLanguage;
    const langs: string[] = [];
    let anyDifferent = false;
    let allProseResolved = true;

    const rebuilt = chunks.map((c, i) => {
      if (c.kind !== 'prose') return c;
      const h = chunkHashes[i];
      const cached = chunkTranslations.get(h) ?? getCachedByHash('wiki', h, targetLang);
      if (!cached) {
        allProseResolved = false;
        return c;
      }
      langs.push(cached.detectedLanguage);
      if (!cached.skipped) anyDifferent = true;
      return { ...c, content: cached.translatedContent };
    });

    return {
      translatedContent: allProseResolved ? reassembleWikiChunks(rebuilt) : null,
      detectedLanguages: langs,
      anyTranslated: anyDifferent,
    };
  }, [chunks, chunkHashes, chunkTranslations, enabled, settings.preferredLanguage]);

  return {
    translatedContent,
    isTranslating,
    detectedLanguages,
    anyTranslated,
  };
}
