// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult, TranslationMetadata } from '@babelr/shared';

/**
 * Optional callback fired after each individual result resolves.
 * Lets callers render translations incrementally instead of waiting
 * for the whole batch to land.
 *
 * For providers that return the whole batch in a single API call
 * (Anthropic, OpenAI), this is fired once per result after parsing,
 * just before the promise resolves — so it's strictly best-effort
 * and primarily a win for sequential providers (Ollama, local
 * Transformers.js) where the time-between-results is long enough
 * that incremental UI updates actually matter.
 */
export type TranslationProgressCallback = (result: TranslationResult) => void;

export interface TranslationProvider {
  name: string;
  translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]>;
  isConfigured(): boolean;
}

export interface CachedTranslation {
  translatedContent: string;
  detectedLanguage: string;
  skipped: boolean;
  targetLanguage: string;
  metadata?: TranslationMetadata;
}

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'local';

export interface TranslationSettings {
  /** Anthropic Claude API key. Read only when provider === 'anthropic'. */
  anthropicApiKey: string;
  /** OpenAI API key. Read only when provider === 'openai'. */
  openaiApiKey: string;
  /** Ollama instance URL. Only read when provider === 'ollama'. */
  ollamaBaseUrl: string;
  /** Optional Ollama model override. Empty string = provider default (llama3.1:8b). */
  ollamaModel: string;
  preferredLanguage: string;
  enabled: boolean;
  provider: ProviderType;
}
