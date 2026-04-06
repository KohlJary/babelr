// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult } from '@babelr/shared';

export interface TranslationProvider {
  name: string;
  translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<TranslationResult[]>;
  isConfigured(): boolean;
}

export interface CachedTranslation {
  translatedContent: string;
  detectedLanguage: string;
  skipped: boolean;
  targetLanguage: string;
}

export interface TranslationSettings {
  apiKey: string;
  preferredLanguage: string;
  enabled: boolean;
}
