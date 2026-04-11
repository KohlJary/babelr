// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult, TranslationMetadata } from '@babelr/shared';

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
  metadata?: TranslationMetadata;
}

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'local';

export interface TranslationSettings {
  /** Shared field — used for both Anthropic and OpenAI. Only whichever provider is selected reads it. */
  apiKey: string;
  /** Ollama instance URL. Only read when provider === 'ollama'. */
  ollamaBaseUrl: string;
  /** Optional Ollama model override. Empty string = provider default (llama3.1:8b). */
  ollamaModel: string;
  preferredLanguage: string;
  enabled: boolean;
  provider: ProviderType;
}
