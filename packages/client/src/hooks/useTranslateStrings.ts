// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useMemo } from 'react';
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
 * General-purpose translation hook for arbitrary strings (plugin
 * content, wiki titles, form labels — anything that isn't a chat
 * message). Mirrors useTranslation's cache semantics (content-hash
 * keyed, per-target-language, localStorage-persistent) but accepts a
 * plain `{ id -> text }` map rather than a MessageWithAuthor array.
 *
 * Returns a map from id to translated text. Strings for which no
 * translation is available yet return the original text verbatim.
 *
 * Exposed to plugin authors via @babelr/client's public surface; used
 * internally by things like the polls plugin to translate poll
 * questions and option labels.
 */
export function useTranslateStrings(
  strings: Record<string, string>,
  settings: TranslationSettings,
): Record<string, string> {
  const [translations, setTranslations] = useState<Map<string, string>>(new Map());

  const provider = useMemo((): TranslationProvider | null => {
    switch (settings.provider) {
      case 'local':
        return new TransformersJsProvider();
      case 'anthropic':
        return settings.anthropicApiKey
          ? new AnthropicProvider(settings.anthropicApiKey)
          : null;
      case 'openai':
        return settings.openaiApiKey ? new OpenAIProvider(settings.openaiApiKey) : null;
      case 'ollama':
        return settings.ollamaBaseUrl
          ? new OllamaProvider(settings.ollamaBaseUrl, settings.ollamaModel || undefined)
          : null;
      default:
        return null;
    }
  }, [
    settings.provider,
    settings.anthropicApiKey,
    settings.openaiApiKey,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
  ]);

  // Key the effect on a stable digest of the strings object so the
  // effect doesn't re-run on every render when the caller passes a
  // fresh object literal.
  const digest = useMemo(
    () => Object.entries(strings).map(([id, s]) => `${id}:${hashContent(s)}`).join('|'),
    [strings],
  );

  useEffect(() => {
    if (!provider) return;
    const targetLang = settings.preferredLanguage;
    const cached = new Map<string, string>();
    const uncached: { id: string; content: string }[] = [];

    for (const [id, text] of Object.entries(strings)) {
      if (!text.trim()) continue;
      const hit = getCachedByHash('message', hashContent(text), targetLang) as
        | CachedTranslation
        | undefined;
      if (hit) {
        if (hit.skipped) cached.set(id, text);
        else cached.set(id, hit.translatedContent);
      } else {
        uncached.push({ id, content: text });
      }
    }
    if (cached.size > 0) {
      setTranslations((prev) => {
        const next = new Map(prev);
        for (const [id, t] of cached) next.set(id, t);
        return next;
      });
    }
    if (uncached.length === 0) return;

    let cancelled = false;
    provider.translate(uncached, targetLang).then((results) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const r of results) {
        const source = uncached.find((u) => u.id === r.id);
        if (!source) continue;
        const translated = r.skipped ? source.content : r.translatedContent;
        next.set(r.id, translated);
        setCachedByHash('message', hashContent(source.content), targetLang, {
          translatedContent: r.translatedContent,
          detectedLanguage: r.detectedLanguage,
          skipped: r.skipped,
          targetLanguage: targetLang,
          metadata: r.metadata,
        });
      }
      setTranslations((prev) => {
        const merged = new Map(prev);
        for (const [id, t] of next) merged.set(id, t);
        return merged;
      });
    }).catch(() => {
      // silent — caller falls back to the original text
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest, provider, settings.preferredLanguage, settings.provider]);

  // Build the output map: translated where available, original otherwise.
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(strings)) {
      out[id] = translations.get(id) ?? text;
    }
    return out;
  }, [strings, translations]);
}
