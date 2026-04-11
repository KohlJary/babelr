// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Which LLM backend the client is asking the server to proxy through.
 * Omitted → 'anthropic' (back-compat with older clients).
 *
 * Ollama is *not* part of the proxied set — it's called directly from
 * the browser so the server isn't in the air-gap story at all. The
 * client-side ProviderType enum adds 'ollama' and 'local' beyond this
 * proxy-only subset.
 */
export type ProxyProviderKind = 'anthropic' | 'openai';

export interface TranslateProxyRequest {
  apiKey: string;
  messages: { id: string; content: string }[];
  targetLanguage: string;
  sourceLanguage?: string;
  glossary?: Record<string, string>;
  /** Which proxied backend to call. Defaults to 'anthropic' for back-compat. */
  provider?: ProxyProviderKind;
}

export type Register =
  | 'casual'
  | 'formal'
  | 'sarcastic'
  | 'technical'
  | 'affectionate'
  | 'neutral';

export type Intent =
  | 'statement'
  | 'question'
  | 'joke'
  | 'correction'
  | 'greeting'
  | 'reference';

export interface IdiomAnnotation {
  original: string;
  explanation: string;
  equivalent?: string;
}

export interface TranslationMetadata {
  register: Register;
  intent: Intent;
  confidence: number;
  idioms: IdiomAnnotation[];
}

export interface TranslationResult {
  id: string;
  translatedContent: string;
  detectedLanguage: string;
  skipped: boolean;
  metadata?: TranslationMetadata;
}

export interface TranslateProxyResponse {
  results: TranslationResult[];
}
