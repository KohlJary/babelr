// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useMemo } from 'react';
import { chunkWikiContent, reassembleWikiChunks, type WikiChunk } from '@babelr/shared';
import {
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
  TransformersJsProvider,
  getCachedByHash,
  setCachedByHash,
  hashContent,
  type TranslationProvider,
  type CachedTranslation,
  type TranslationSettings,
} from '../translation';

/**
 * A single reassembly-ready chunk returned to the caller. `original`
 * is the source content verbatim; `translated` is the translator's
 * output (only for prose chunks that actually ran through the API
 * and resolved). Non-prose chunks have no metadata and are passed
 * through as-is.
 */
export interface TranslatedChunk {
  kind: 'prose' | 'code' | 'blank';
  original: string;
  translated: string | null;
  cached: CachedTranslation | null;
}

interface UseWikiTranslationResult {
  /** Per-chunk stream for rendering the page with in-line metadata indicators */
  chunks: TranslatedChunk[];
  /** Convenience: reassembled translated markdown, or null while still loading */
  translatedContent: string | null;
  /** True if at least one chunk is currently being translated */
  isTranslating: boolean;
  /** How many prose chunks still have to resolve in the current in-flight batch. 0 when idle. */
  progressRemaining: number;
  /** How many prose chunks are being translated in total in the current batch. 0 when idle. */
  progressTotal: number;
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
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressRemaining, setProgressRemaining] = useState(0);

  // Provider reconstruction on settings change — mirrors useTranslation.
  useEffect(() => {
    switch (settings.provider) {
      case 'local':
        providerRef.current = new TransformersJsProvider();
        break;
      case 'anthropic':
        providerRef.current = settings.anthropicApiKey
          ? new AnthropicProvider(settings.anthropicApiKey)
          : null;
        break;
      case 'openai':
        providerRef.current = settings.openaiApiKey
          ? new OpenAIProvider(settings.openaiApiKey)
          : null;
        break;
      case 'ollama':
        providerRef.current = settings.ollamaBaseUrl
          ? new OllamaProvider(settings.ollamaBaseUrl, settings.ollamaModel || undefined)
          : null;
        break;
      default:
        providerRef.current = null;
    }
  }, [
    settings.anthropicApiKey,
    settings.openaiApiKey,
    settings.provider,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
  ]);

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
    setProgressTotal(uncached.length);
    setProgressRemaining(uncached.length);

    const provider = providerRef.current;
    const batch = uncached.map((u) => ({ id: u.hash, content: u.content }));

    // onProgress fires as each chunk resolves. For Ollama (sequential)
    // this drops paragraphs into the page one at a time as the model
    // finishes them, so the user sees partial results instead of
    // watching a blank "Translating…" indicator for 30 seconds. Cloud
    // providers fire it at the end of their single API call, which is
    // a wash.
    const onChunkDone = (r: import('@babelr/shared').TranslationResult) => {
      const entry: CachedTranslation = {
        translatedContent: r.translatedContent,
        detectedLanguage: r.detectedLanguage,
        skipped: r.skipped,
        targetLanguage: targetLang,
        metadata: r.metadata,
      };
      setCachedByHash('wiki', r.id, targetLang, entry);
      setChunkTranslations((prev) => {
        const next = new Map(prev);
        next.set(r.id, entry);
        return next;
      });
      inflightRef.current.delete(`${r.id}:${targetLang}`);
      setProgressRemaining((n) => Math.max(0, n - 1));
    };

    provider
      .translate(batch, targetLang, undefined, onChunkDone)
      .then(() => {
        // Fallback: make sure any uncached entries we started with
        // get their inflight flag cleared even if the provider didn't
        // fire onProgress for them (belt-and-suspenders).
        for (const u of uncached) inflightRef.current.delete(`${u.hash}:${targetLang}`);
        setIsTranslating(false);
        setProgressRemaining(0);
        setProgressTotal(0);
      })
      .catch((err) => {
        console.error('Wiki translation failed:', err);
        for (const u of uncached) inflightRef.current.delete(`${u.hash}:${targetLang}`);
        setIsTranslating(false);
        setProgressRemaining(0);
        setProgressTotal(0);
      });
  }, [
    chunks,
    chunkHashes,
    enabled,
    settings.enabled,
    settings.preferredLanguage,
    settings.anthropicApiKey,
    settings.openaiApiKey,
    settings.provider,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
  ]);

  // Pull the current translation state (memory + localStorage) for
  // every prose chunk, falling back to the original content for chunks
  // that aren't translated yet. Emits both the per-chunk stream (for
  // UI indicators) and the reassembled translatedContent string (for
  // callers that just want the blob).
  const { chunks: translatedChunks, translatedContent, detectedLanguages, anyTranslated } = useMemo(() => {
    if (!enabled || !settings.preferredLanguage) {
      return {
        chunks: chunks.map<TranslatedChunk>((c) => ({
          kind: c.kind,
          original: c.content,
          translated: null,
          cached: null,
        })),
        translatedContent: null,
        detectedLanguages: [],
        anyTranslated: false,
      };
    }
    const targetLang = settings.preferredLanguage;
    const langs: string[] = [];
    let anyDifferent = false;
    let allProseResolved = true;

    const emitted: TranslatedChunk[] = chunks.map((c, i) => {
      if (c.kind !== 'prose') {
        return { kind: c.kind, original: c.content, translated: null, cached: null };
      }
      const h = chunkHashes[i];
      const cached = chunkTranslations.get(h) ?? getCachedByHash('wiki', h, targetLang) ?? null;
      if (!cached) {
        allProseResolved = false;
        return { kind: 'prose', original: c.content, translated: null, cached: null };
      }
      langs.push(cached.detectedLanguage);
      if (!cached.skipped) anyDifferent = true;
      return {
        kind: 'prose',
        original: c.content,
        translated: cached.translatedContent,
        cached,
      };
    });

    // Rebuild a single markdown string for any caller that wants the
    // blob form. We use the translator output where available and
    // fall back to the source.
    const rebuiltForBlob: WikiChunk[] = emitted.map((c) => ({
      kind: c.kind,
      content: c.translated ?? c.original,
    }));

    return {
      chunks: emitted,
      translatedContent: allProseResolved ? reassembleWikiChunks(rebuiltForBlob) : null,
      detectedLanguages: langs,
      anyTranslated: anyDifferent,
    };
  }, [chunks, chunkHashes, chunkTranslations, enabled, settings.preferredLanguage]);

  return {
    chunks: translatedChunks,
    translatedContent,
    isTranslating,
    progressTotal,
    progressRemaining,
    detectedLanguages,
    anyTranslated,
  };
}
