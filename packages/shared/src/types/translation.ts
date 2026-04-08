// SPDX-License-Identifier: Hippocratic-3.0

export interface TranslateProxyRequest {
  apiKey: string;
  messages: { id: string; content: string }[];
  targetLanguage: string;
  sourceLanguage?: string;
  glossary?: Record<string, string>;
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
