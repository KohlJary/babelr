// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * Each field caches independently by content hash so two events
 * with the same title ("Standup") share the same cache entry. The
 * `detectedLanguage` comes from whichever field has metadata —
 * usually the description (longer, more reliable detection), or
 * the title as a fallback.
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
 * Compose a single `TranslatedEventFields` from the title + optional
 * description cache entries for one event. Returns null if the
 * required fields aren't all present yet.
 */
function assembleEventView(
  event: EventView,
  titleEntry: CachedTranslation,
  descEntry: CachedTranslation | null,
): TranslatedEventFields {
  const anyTranslated =
    !titleEntry.skipped || (!!descEntry && !descEntry.skipped);
  const detectedLanguage =
    descEntry?.detectedLanguage || titleEntry.detectedLanguage;
  return {
    title: titleEntry.translatedContent,
    description: descEntry?.translatedContent ?? event.description,
    titleSkipped: titleEntry.skipped,
    descriptionSkipped: descEntry?.skipped ?? true,
    titleMetadata: titleEntry.metadata,
    descriptionMetadata: descEntry?.metadata,
    detectedLanguage,
    anyTranslated,
  };
}

/**
 * Translate event titles and descriptions through the tone-
 * preserving pipeline used by messages and wiki content. Mirrors
 * the session-state-plus-cache-merge shape of `useTranslation` for
 * messages — field-hash keyed caching via `getCachedByHash`, batch
 * writes into a single `/translate` call, and a `useMemo` that
 * merges in-session results with persisted cache entries at return
 * time.
 *
 * Both title and description of every event enter the batch as
 * `{id: 'evt-{eventId}-title', content: 'Standup'}` style items.
 * The batch id lets us route each result back to its source field
 * when the response arrives.
 */
export function useEventTranslation(
  events: EventView[],
  settings: TranslationSettings,
): UseEventTranslationResult {
  // Session state: field-hash -> cached translation. Never shrinks
  // within a mount; cleared on unmount. The module-level cache
  // (getCachedByHash) is what persists across sessions.
  const [sessionFields, setSessionFields] = useState<Map<string, CachedTranslation>>(
    () => new Map(),
  );
  const [loadingHashes, setLoadingHashes] = useState<Set<string>>(() => new Set());
  const providerRef = useRef<TranslationProvider | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());

  // Provider construction — identical branching to useTranslation.
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

  // Fetch uncached fields from the provider. Mirrors the shape of
  // useTranslation's fetch effect — direct state writes in the
  // .then() callback rather than a derived-from-cache pattern.
  useEffect(() => {
    if (!settings.enabled || !providerRef.current?.isConfigured()) return;
    if (!settings.preferredLanguage) return;

    const targetLang = settings.preferredLanguage;
    const uncached: { id: string; content: string; fieldHash: string }[] = [];
    const seenHashes = new Set<string>();

    for (const ev of events) {
      if (ev.title) {
        const titleHash = hashContent(ev.title);
        const inflightKey = `${titleHash}:${targetLang}`;
        if (
          !inflightRef.current.has(inflightKey) &&
          !getCachedByHash('event', titleHash, targetLang) &&
          !seenHashes.has(inflightKey)
        ) {
          uncached.push({
            id: batchId(ev.id, 'title'),
            content: ev.title,
            fieldHash: titleHash,
          });
          seenHashes.add(inflightKey);
        }
      }
      if (ev.description) {
        const descHash = hashContent(ev.description);
        const inflightKey = `${descHash}:${targetLang}`;
        if (
          !inflightRef.current.has(inflightKey) &&
          !getCachedByHash('event', descHash, targetLang) &&
          !seenHashes.has(inflightKey)
        ) {
          uncached.push({
            id: batchId(ev.id, 'desc'),
            content: ev.description,
            fieldHash: descHash,
          });
          seenHashes.add(inflightKey);
        }
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
        const resultEntries: Array<[string, CachedTranslation]> = [];
        for (const r of results) {
          const parsed = parseBatchId(r.id);
          if (!parsed) continue;
          // Find the uncached entry that matched this batch id to
          // get back to the field hash. Avoids re-hashing content.
          const u = uncached.find((x) => x.id === r.id);
          if (!u) continue;
          const entry: CachedTranslation = {
            translatedContent: r.translatedContent,
            detectedLanguage: r.detectedLanguage,
            skipped: r.skipped,
            targetLanguage: targetLang,
            metadata: r.metadata,
          };
          setCachedByHash('event', u.fieldHash, targetLang, entry);
          resultEntries.push([u.fieldHash, entry]);
        }
        setSessionFields((prev) => {
          const next = new Map(prev);
          for (const [hash, entry] of resultEntries) next.set(hash, entry);
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
        console.error('Event translation failed:', err);
        for (const k of inflightKeys) inflightRef.current.delete(k);
        setLoadingHashes((prev) => {
          const next = new Set(prev);
          for (const k of inflightKeys) next.delete(k);
          return next;
        });
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
  ]);

  // Assemble the per-event view by merging session state with
  // persisted cache entries. Computed at return time so both
  // sources are live. Matches useTranslation's `allTranslations`
  // memo pattern.
  const translations = useMemo(() => {
    if (!settings.enabled || !settings.preferredLanguage) {
      return new Map<string, TranslatedEventFields>();
    }
    const targetLang = settings.preferredLanguage;
    const out = new Map<string, TranslatedEventFields>();
    for (const ev of events) {
      if (!ev.title) continue;
      const titleHash = hashContent(ev.title);
      const titleEntry =
        sessionFields.get(titleHash) ??
        getCachedByHash('event', titleHash, targetLang) ??
        null;
      if (!titleEntry) continue;

      let descEntry: CachedTranslation | null = null;
      if (ev.description) {
        const descHash = hashContent(ev.description);
        descEntry =
          sessionFields.get(descHash) ??
          getCachedByHash('event', descHash, targetLang) ??
          null;
        if (!descEntry) continue;
      }
      out.set(ev.id, assembleEventView(ev, titleEntry, descEntry));
    }
    return out;
  }, [events, sessionFields, settings.enabled, settings.preferredLanguage]);

  const isTranslating = loadingHashes.size > 0;

  return { translations, isTranslating };
}
