// SPDX-License-Identifier: Hippocratic-3.0

export interface TranslateProxyRequest {
  apiKey: string;
  messages: { id: string; content: string }[];
  targetLanguage: string;
  sourceLanguage?: string;
}

export interface TranslationResult {
  id: string;
  translatedContent: string;
  detectedLanguage: string;
  skipped: boolean;
}

export interface TranslateProxyResponse {
  results: TranslationResult[];
}
