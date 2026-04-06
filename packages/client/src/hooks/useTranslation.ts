// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import {
  AnthropicProvider,
  TransformersJsProvider,
  getCached,
  setCached,
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
    if (settings.provider === 'local') {
      providerRef.current = new TransformersJsProvider();
    } else if (settings.provider === 'anthropic' && settings.apiKey) {
      providerRef.current = new AnthropicProvider(settings.apiKey);
    } else {
      providerRef.current = null;
    }
  }, [settings.apiKey, settings.provider]);

  // Translate uncached messages
  useEffect(() => {
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const uncached = messages.filter((m) => {
      const id = m.message.id;
      if (inflightRef.current.has(id)) return false;
      return !getCached(id, settings.preferredLanguage);
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
    const targetLang = settings.preferredLanguage;

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
          setCached(r.id, targetLang, entry);
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
  }, [messages, settings.enabled, settings.preferredLanguage, settings.apiKey, settings.provider]);

  // Merge in-memory state with cache
  const allTranslations = useMemo(() => {
    const merged = new Map(translations);
    for (const m of messages) {
      if (!merged.has(m.message.id)) {
        const cached = getCached(m.message.id, settings.preferredLanguage);
        if (cached) merged.set(m.message.id, cached);
      }
    }
    return merged;
  }, [messages, translations, settings.preferredLanguage]);

  const isTranslating = useCallback((messageId: string) => loading.has(messageId), [loading]);

  return { translations: allTranslations, isTranslating };
}
