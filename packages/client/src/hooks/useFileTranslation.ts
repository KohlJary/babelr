// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileView } from '@babelr/shared';
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

export interface TranslatedFileFields {
  description: string | null;
  detectedLanguage: string;
  anyTranslated: boolean;
}

interface UseFileTranslationResult {
  translations: Map<string, TranslatedFileFields>;
  isTranslating: boolean;
}

/**
 * Translate file descriptions through the tone-preserving pipeline.
 * Comments are handled by useChat + useTranslation (same as event
 * chat) since files now use the message pipeline for their comment
 * threads.
 */
export function useFileTranslation(
  files: FileView[],
  _comments: unknown[],
  settings: TranslationSettings,
): UseFileTranslationResult {
  const [sessionFields, setSessionFields] = useState<Map<string, CachedTranslation>>(
    () => new Map(),
  );
  const [loadingHashes, setLoadingHashes] = useState<Set<string>>(() => new Set());
  const providerRef = useRef<TranslationProvider | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const targetLang = settings.preferredLanguage;
    const uncached: { id: string; content: string; fieldHash: string }[] = [];
    const seenHashes = new Set<string>();

    for (const f of files) {
      if (!f.description) continue;
      const hash = hashContent(f.description);
      const inflightKey = `${hash}:${targetLang}`;
      if (
        !inflightRef.current.has(inflightKey) &&
        !getCachedByHash('file', hash, targetLang) &&
        !seenHashes.has(inflightKey)
      ) {
        uncached.push({ id: `desc-${f.id}`, content: f.description, fieldHash: hash });
        seenHashes.add(inflightKey);
      }
    }

    if (uncached.length === 0) return;

    const inflightKeys = uncached.map((u) => `${u.fieldHash}:${targetLang}`);
    for (const k of inflightKeys) inflightRef.current.add(k);
    setLoadingHashes((prev) => {
      const next = new Set(prev);
      for (const k of inflightKeys) next.add(k);
      return next;
    });

    const provider = providerRef.current;
    const batch = uncached.map((u) => ({ id: u.id, content: u.content }));

    provider
      .translate(batch, targetLang)
      .then((results) => {
        const entries: Array<[string, CachedTranslation]> = [];
        for (const r of results) {
          const u = uncached.find((x) => x.id === r.id);
          if (!u) continue;
          const entry: CachedTranslation = {
            translatedContent: r.translatedContent,
            detectedLanguage: r.detectedLanguage,
            skipped: r.skipped,
            targetLanguage: targetLang,
            metadata: r.metadata,
          };
          setCachedByHash('file', u.fieldHash, targetLang, entry);
          entries.push([u.fieldHash, entry]);
        }
        setSessionFields((prev) => {
          const next = new Map(prev);
          for (const [hash, entry] of entries) next.set(hash, entry);
          return next;
        });
        for (const k of inflightKeys) inflightRef.current.delete(k);
        setLoadingHashes((prev) => {
          const next = new Set(prev);
          for (const k of inflightKeys) next.delete(k);
          return next;
        });
      })
      .catch((err) => {
        console.error('File translation failed:', err);
        for (const k of inflightKeys) inflightRef.current.delete(k);
        setLoadingHashes((prev) => {
          const next = new Set(prev);
          for (const k of inflightKeys) next.delete(k);
          return next;
        });
      });
  }, [files, settings.enabled, settings.preferredLanguage, settings.anthropicApiKey, settings.openaiApiKey, settings.provider, settings.ollamaBaseUrl, settings.ollamaModel]);

  const translations = useMemo(() => {
    if (!settings.enabled || !settings.preferredLanguage) {
      return new Map<string, TranslatedFileFields>();
    }
    const targetLang = settings.preferredLanguage;
    const out = new Map<string, TranslatedFileFields>();
    for (const f of files) {
      if (!f.description) continue;
      const hash = hashContent(f.description);
      const entry =
        sessionFields.get(hash) ??
        getCachedByHash('file', hash, targetLang) ??
        null;
      if (!entry) continue;
      out.set(f.id, {
        description: entry.translatedContent,
        detectedLanguage: entry.detectedLanguage,
        anyTranslated: !entry.skipped,
      });
    }
    return out;
  }, [files, sessionFields, settings.enabled, settings.preferredLanguage]);

  return { translations, isTranslating: loadingHashes.size > 0 };
}
