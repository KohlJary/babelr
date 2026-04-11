// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { EventView, TranslationMetadata } from '@babelr/shared';
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
 * Per-event translated view returned by `useEventTranslation`.
 * The caller picks `title`/`description` when the show-original
 * toggle is off, and falls back to the raw event fields otherwise.
 *
 * Each field caches independently by content hash so two events
 * with the same title ("Standup") share the same cache entry. The
 * `detectedLanguage` is reported from whichever field we have
 * metadata for — usually the description (longer, more reliable
 * detection), or the title as a fallback.
 */
export interface TranslatedEventFields {
  title: string;
  description: string | null;
  titleSkipped: boolean;
  descriptionSkipped: boolean;
  titleMetadata?: TranslationMetadata;
  descriptionMetadata?: TranslationMetadata;
  detectedLanguage: string;
  /** True if at least one field was actually translated (source != target). */
  anyTranslated: boolean;
}

interface UseEventTranslationResult {
  /** Map keyed by event id. Only populated for events whose fields resolved. */
  translations: Map<string, TranslatedEventFields>;
  /** True if at least one field is still in flight. */
  isTranslating: boolean;
}

type FieldKind = 'title' | 'desc';

/**
 * Build a synthetic batch id that encodes both the event id and
 * which field it's for. The `/translate` endpoint just echoes the
 * id back on each result, so we use it as a routing key when the
 * response lands.
 */
function batchId(eventId: string, field: FieldKind): string {
  return `evt-${eventId}-${field}`;
}

function parseBatchId(id: string): { eventId: string; field: FieldKind } | null {
  const match = /^evt-(.+)-(title|desc)$/.exec(id);
  if (!match) return null;
  return { eventId: match[1], field: match[2] as FieldKind };
}

/**
 * Translate event titles and descriptions through the same tone-
 * preserving pipeline used for messages and wiki content. Runs on
 * any component that has an `EventView[]` to display; cache hits
 * are free and cache misses batch into a single `/translate` call
 * per render pass.
 *
 * Design mirrors `useWikiTranslation` — same cache module, same
 * provider pattern, just a different content unit.
 */
export function useEventTranslation(
  events: EventView[],
  settings: TranslationSettings,
): UseEventTranslationResult {
  const [translations, setTranslations] = useState<Map<string, TranslatedEventFields>>(
    () => new Map(),
  );
  const [inflight, setInflight] = useState<Set<string>>(() => new Set());
  const providerRef = useRef<TranslationProvider | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());

  // Provider construction — identical branching to useWikiTranslation.
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

  /**
   * Load any field translations already present in the cache and
   * assemble them into the per-event view shape. Runs on every
   * render as part of the derived state memo; callers see both
   * freshly-fetched and previously-cached entries with no
   * additional plumbing.
   */
  const buildFromCache = useCallback((): Map<string, TranslatedEventFields> => {
    if (!settings.enabled || !settings.preferredLanguage) return new Map();
    const targetLang = settings.preferredLanguage;
    const out = new Map<string, TranslatedEventFields>();
    for (const ev of events) {
      if (!ev.title && !ev.description) continue;
      const titleHash = hashContent(ev.title);
      const descHash = ev.description ? hashContent(ev.description) : null;
      const titleCached = getCachedByHash('event', titleHash, targetLang);
      const descCached = descHash ? getCachedByHash('event', descHash, targetLang) : null;

      // Only include the event in the result if every field we care
      // about has resolved. Partial entries are hidden so the caller
      // never flashes a half-translated row.
      if (!titleCached) continue;
      if (ev.description && !descCached) continue;

      const anyTranslated = !titleCached.skipped || (!!descCached && !descCached.skipped);
      const detectedLanguage =
        descCached?.detectedLanguage || titleCached.detectedLanguage;

      out.set(ev.id, {
        title: titleCached.translatedContent,
        description: descCached?.translatedContent ?? ev.description,
        titleSkipped: titleCached.skipped,
        descriptionSkipped: descCached?.skipped ?? true,
        titleMetadata: titleCached.metadata,
        descriptionMetadata: descCached?.metadata,
        detectedLanguage,
        anyTranslated,
      });
    }
    return out;
  }, [events, settings.enabled, settings.preferredLanguage]);

  // Hydrate the derived state from cache on every render. Cheap
  // because getCachedByHash reads from the in-memory layer for hot
  // entries and falls back to localStorage only on cold hits.
  useEffect(() => {
    setTranslations(buildFromCache());
  }, [buildFromCache]);

  // Fetch any uncached fields from the provider.
  useEffect(() => {
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const targetLang = settings.preferredLanguage;
    const uncached: { id: string; content: string }[] = [];
    const seenHashes = new Set<string>();

    for (const ev of events) {
      if (!ev.title) continue;
      const titleHash = hashContent(ev.title);
      const titleCacheKey = `${titleHash}:${targetLang}`;
      if (
        !inflightRef.current.has(titleCacheKey) &&
        !getCachedByHash('event', titleHash, targetLang) &&
        !seenHashes.has(titleCacheKey)
      ) {
        uncached.push({ id: batchId(ev.id, 'title'), content: ev.title });
        seenHashes.add(titleCacheKey);
      }
      if (ev.description) {
        const descHash = hashContent(ev.description);
        const descCacheKey = `${descHash}:${targetLang}`;
        if (
          !inflightRef.current.has(descCacheKey) &&
          !getCachedByHash('event', descHash, targetLang) &&
          !seenHashes.has(descCacheKey)
        ) {
          uncached.push({ id: batchId(ev.id, 'desc'), content: ev.description });
          seenHashes.add(descCacheKey);
        }
      }
    }

    if (uncached.length === 0) return;

    // Mark each uncached field as in-flight via the ref so a
    // parallel render pass doesn't re-enqueue the same field.
    // The state version of inflight is kept separately for the
    // isTranslating return value — refs don't trigger re-renders.
    for (const u of uncached) {
      const parsed = parseBatchId(u.id);
      if (!parsed) continue;
      const ev = events.find((e) => e.id === parsed.eventId);
      if (!ev) continue;
      const content = parsed.field === 'title' ? ev.title : ev.description ?? '';
      const key = `${hashContent(content)}:${targetLang}`;
      inflightRef.current.add(key);
    }
    setInflight(new Set(inflightRef.current));

    const provider = providerRef.current;

    provider
      .translate(uncached, targetLang)
      .then((results) => {
        for (const r of results) {
          const parsed = parseBatchId(r.id);
          if (!parsed) continue;
          const ev = events.find((e) => e.id === parsed.eventId);
          if (!ev) continue;
          const source = parsed.field === 'title' ? ev.title : ev.description ?? '';
          const hash = hashContent(source);
          const entry: CachedTranslation = {
            translatedContent: r.translatedContent,
            detectedLanguage: r.detectedLanguage,
            skipped: r.skipped,
            targetLanguage: targetLang,
            metadata: r.metadata,
          };
          setCachedByHash('event', hash, targetLang, entry);
          inflightRef.current.delete(`${hash}:${targetLang}`);
        }
        setInflight(new Set(inflightRef.current));
        setTranslations(buildFromCache());
      })
      .catch((err) => {
        console.error('Event translation failed:', err);
        for (const u of uncached) {
          const parsed = parseBatchId(u.id);
          if (!parsed) continue;
          const ev = events.find((e) => e.id === parsed.eventId);
          if (!ev) continue;
          const content = parsed.field === 'title' ? ev.title : ev.description ?? '';
          inflightRef.current.delete(`${hashContent(content)}:${targetLang}`);
        }
        setInflight(new Set(inflightRef.current));
      });
  }, [
    events,
    settings.enabled,
    settings.preferredLanguage,
    settings.anthropicApiKey,
    settings.openaiApiKey,
    settings.provider,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
    buildFromCache,
  ]);

  const isTranslating = useMemo(() => inflight.size > 0, [inflight]);

  return { translations, isTranslating };
}
