// SPDX-License-Identifier: Hippocratic-3.0
import type { CachedTranslation } from './types';

const cache = new Map<string, CachedTranslation>();

function key(messageId: string, targetLang: string): string {
  return `${messageId}:${targetLang}`;
}

export function getCached(messageId: string, targetLang: string): CachedTranslation | undefined {
  return cache.get(key(messageId, targetLang));
}

export function setCached(
  messageId: string,
  targetLang: string,
  entry: CachedTranslation,
): void {
  cache.set(key(messageId, targetLang), entry);
}

export function clearCache(): void {
  cache.clear();
}
