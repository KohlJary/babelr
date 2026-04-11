// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslateProxyResponse, TranslationResult } from '@babelr/shared';
import type { TranslationProvider, TranslationProgressCallback } from './types';

/**
 * OpenAI-backed translation provider. Goes through the server's
 * `/translate` proxy (same as Anthropic) so the API key never sits
 * in browser code that a page script could read. The server
 * dispatches to its OpenAI adapter when `provider: 'openai'` is set
 * on the request body.
 */
export class OpenAIProvider implements TranslationProvider {
  name = 'openai';

  constructor(private apiKey: string) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    const res = await fetch('/api/translate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.apiKey,
        messages,
        targetLanguage,
        sourceLanguage,
        provider: 'openai',
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? 'Translation failed');
    }

    const data: TranslateProxyResponse = await res.json();
    if (onProgress) {
      for (const r of data.results) onProgress(r);
    }
    return data.results;
  }
}
