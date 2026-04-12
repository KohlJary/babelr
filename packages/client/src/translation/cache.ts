// SPDX-License-Identifier: Hippocratic-3.0
import type { CachedTranslation } from './types';

/**
 * Translation cache with localStorage persistence and content-hash
 * keying. Designed to back three use cases:
 *
 * - Chat messages (legacy API kept intact): keyed by messageId +
 *   targetLang. Back-compat shim wraps the hashed layer so existing
 *   hooks don't need to migrate yet.
 * - Wiki page paragraphs: keyed by content hash + targetLang +
 *   contentKind='wiki'. Edits auto-invalidate because the hash changes.
 * - Future: DMs and any other mutable content — same hashed API.
 *
 * Storage layout: one localStorage key per entry, prefixed with
 * `babelr:tx:`. This sidesteps the global-JSON-blob problem where
 * rewriting a single entry forces a full re-serialize, and lets the
 * browser do its own LRU inside the 5MB quota. An in-memory Map
 * mirrors the hot set so we don't round-trip localStorage on every
 * render.
 */

const STORAGE_PREFIX = 'babelr:tx:';
const MAX_ENTRIES = 2000; // soft cap — evict oldest when exceeded
const INDEX_KEY = 'babelr:tx:index';

export type ContentKind = 'message' | 'wiki' | 'dm' | 'event' | 'file';

interface StoredEntry {
  entry: CachedTranslation;
  /** Last-accessed timestamp, used for LRU eviction */
  touched: number;
}

const memoryCache = new Map<string, StoredEntry>();

/**
 * Fast, stable, non-cryptographic hash (FNV-1a 32-bit). Collisions are
 * possible but the cache worst case is a single mis-return that the
 * caller can revalidate — and the targetLang tail makes collisions
 * within a single user's session vanishingly rare.
 */
export function hashContent(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function storageKey(kind: ContentKind, hash: string, targetLang: string): string {
  return `${STORAGE_PREFIX}${kind}:${hash}:${targetLang}`;
}

/**
 * Read all our keys out of the persisted index. We maintain it
 * explicitly (rather than scanning localStorage) so we don't walk
 * other apps' keys and so eviction has a cheap ordered view.
 */
function readIndex(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(keys: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(keys));
  } catch {
    /* quota or unavailable — ignore */
  }
}

function evictOldest(): void {
  const keys = readIndex();
  if (keys.length <= MAX_ENTRIES) return;
  // Oldest first (we push new/touched to the tail)
  const toEvict = keys.slice(0, keys.length - MAX_ENTRIES);
  for (const k of toEvict) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
    memoryCache.delete(k);
  }
  writeIndex(keys.slice(keys.length - MAX_ENTRIES));
}

function persist(k: string, stored: StoredEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(k, JSON.stringify(stored));
    const keys = readIndex();
    const filtered = keys.filter((x) => x !== k);
    filtered.push(k);
    writeIndex(filtered);
    evictOldest();
  } catch {
    /* quota exceeded, fall through — memory cache still works */
  }
}

function loadFromStorage(k: string): StoredEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEntry;
    if (!parsed || typeof parsed !== 'object' || !parsed.entry) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- *
 * Hashed API — used by wiki (and eventually messages/DMs)              *
 * -------------------------------------------------------------------- */

export function getCachedByHash(
  kind: ContentKind,
  hash: string,
  targetLang: string,
): CachedTranslation | undefined {
  const k = storageKey(kind, hash, targetLang);
  const mem = memoryCache.get(k);
  if (mem) {
    mem.touched = Date.now();
    return mem.entry;
  }
  const loaded = loadFromStorage(k);
  if (loaded) {
    memoryCache.set(k, loaded);
    return loaded.entry;
  }
  return undefined;
}

export function setCachedByHash(
  kind: ContentKind,
  hash: string,
  targetLang: string,
  entry: CachedTranslation,
): void {
  const k = storageKey(kind, hash, targetLang);
  const stored: StoredEntry = { entry, touched: Date.now() };
  memoryCache.set(k, stored);
  persist(k, stored);
}

/* -------------------------------------------------------------------- *
 * Back-compat API — messages still key by id                           *
 * -------------------------------------------------------------------- */

/**
 * Messages currently key by id because their content is effectively
 * immutable post-send (edits tombstone). We keep the shape stable so
 * `useTranslation.ts` doesn't need to change in this PR — a follow-up
 * can migrate messages onto hashContent once we want edit-aware
 * cache invalidation for chat too.
 */
function legacyKey(messageId: string, targetLang: string): string {
  return `${STORAGE_PREFIX}message-id:${messageId}:${targetLang}`;
}

export function getCached(messageId: string, targetLang: string): CachedTranslation | undefined {
  const k = legacyKey(messageId, targetLang);
  const mem = memoryCache.get(k);
  if (mem) return mem.entry;
  const loaded = loadFromStorage(k);
  if (loaded) {
    memoryCache.set(k, loaded);
    return loaded.entry;
  }
  return undefined;
}

export function setCached(
  messageId: string,
  targetLang: string,
  entry: CachedTranslation,
): void {
  const k = legacyKey(messageId, targetLang);
  const stored: StoredEntry = { entry, touched: Date.now() };
  memoryCache.set(k, stored);
  persist(k, stored);
}

export function clearCache(): void {
  memoryCache.clear();
  if (typeof localStorage === 'undefined') return;
  const keys = readIndex();
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  writeIndex([]);
}
