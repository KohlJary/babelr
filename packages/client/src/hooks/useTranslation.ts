// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
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

export function useTranslation(messages: MessageWithAuthor[], settings: TranslationSettings) {
  const [translations, setTranslations] = useState<Map<string, CachedTranslation>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const providerRef = useRef<TranslationProvider | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());

  // Create/update provider based on settings
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

  // Translate uncached messages
  useEffect(() => {
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const targetLang = settings.preferredLanguage;

    const uncached = messages.filter((m) => {
      const id = m.message.id;
      if (inflightRef.current.has(id)) return false;
      const hash = hashContent(m.message.content);
      return !getCachedByHash('message', hash, targetLang);
    });

    if (uncached.length === 0) return;

    // Mark as in-flight
    for (const m of uncached) {
      inflightRef.current.add(m.message.id);
    }
    setLoading((prev) => {
      const next = new Set(prev);
      uncached.forEach((m) => next.add(m.message.id));
      return next;
    });

    const batch = uncached.map((m) => ({ id: m.message.id, content: m.message.content }));
    const provider = providerRef.current;

    provider
      .translate(batch, targetLang)
      .then((results) => {
        const newTranslations = new Map<string, CachedTranslation>();
        for (const r of results) {
          const entry: CachedTranslation = {
            translatedContent: r.translatedContent,
            detectedLanguage: r.detectedLanguage,
            skipped: r.skipped,
            targetLanguage: targetLang,
            metadata: r.metadata,
          };
          // Find the original message content to hash for cache key
          const msg = uncached.find((m) => m.message.id === r.id);
          if (msg) {
            const hash = hashContent(msg.message.content);
            setCachedByHash('message', hash, targetLang, entry);
          }
          newTranslations.set(r.id, entry);
        }
        setTranslations((prev) => new Map([...prev, ...newTranslations]));
        setLoading((prev) => {
          const next = new Set(prev);
          results.forEach((r) => next.delete(r.id));
          return next;
        });
        for (const r of results) {
          inflightRef.current.delete(r.id);
        }
      })
      .catch((err) => {
        console.error('Translation failed:', err);
        setLoading((prev) => {
          const next = new Set(prev);
          uncached.forEach((m) => next.delete(m.message.id));
          return next;
        });
        for (const m of uncached) {
          inflightRef.current.delete(m.message.id);
        }
      });
  }, [
    messages,
    settings.enabled,
    settings.preferredLanguage,
    settings.anthropicApiKey,
    settings.openaiApiKey,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
    settings.provider,
  ]);

  // Merge in-memory state with cache
  const allTranslations = useMemo(() => {
    const merged = new Map(translations);
    for (const m of messages) {
      if (!merged.has(m.message.id)) {
        const hash = hashContent(m.message.content);
        const cached = getCachedByHash('message', hash, settings.preferredLanguage);
        if (cached) merged.set(m.message.id, cached);
      }
    }
    return merged;
  }, [messages, translations, settings.preferredLanguage]);

  const isTranslating = useCallback((messageId: string) => loading.has(messageId), [loading]);

  return { translations: allTranslations, isTranslating };
}
