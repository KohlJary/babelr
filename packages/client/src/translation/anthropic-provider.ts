// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslateProxyResponse, TranslationResult } from '@babelr/shared';
import type { TranslationProvider } from './types';

export class AnthropicProvider implements TranslationProvider {
  name = 'anthropic';

  constructor(private apiKey: string) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
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
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? 'Translation failed');
    }

    const data: TranslateProxyResponse = await res.json();
    return data.results;
  }
}
