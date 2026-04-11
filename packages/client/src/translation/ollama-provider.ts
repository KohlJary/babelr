// SPDX-License-Identifier: Hippocratic-3.0
import { buildPrompt, parseResponse, type TranslationResult } from '@babelr/shared';
import type { TranslationProvider } from './types';

const DEFAULT_MODEL = 'llama3.1:8b';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Ollama-backed translation provider. Unlike the Anthropic and OpenAI
 * providers, this hits the user's Ollama instance **directly from the
 * browser** — the Babelr server is not involved at all. That's
 * deliberate: the whole point of Ollama support is the enterprise
 * air-gap / self-hosted story where the server shouldn't be in the
 * translation path.
 *
 * Consequences:
 * - CORS: the user's Ollama instance must allow the Babelr origin.
 *   Ollama 0.1.23+ respects `OLLAMA_ORIGINS`; for local dev, running
 *   `OLLAMA_ORIGINS='*' ollama serve` is the simplest path. In
 *   enterprise deployments the reverse proxy in front of Ollama
 *   typically handles CORS.
 * - Timeout: local models take longer than cloud APIs. Cap at 60s
 *   rather than the 30s we use for cloud providers.
 * - Prompt reuse: we call `buildPrompt` and `parseResponse` from
 *   `@babelr/shared` so every LLM backend goes through the same
 *   three-stage classify-translate-idiom pipeline and returns the
 *   same shape.
 */
export class OllamaProvider implements TranslationProvider {
  name = 'ollama';

  constructor(
    private baseUrl: string,
    private model: string = DEFAULT_MODEL,
  ) {}

  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  async translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<TranslationResult[]> {
    const prompt = buildPrompt(messages, targetLanguage, sourceLanguage);

    // Normalize the base URL — people paste it with or without trailing
    // slash, and sometimes with /api already appended. Strip both so
    // we construct a clean `${base}/api/chat`.
    const base = this.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const url = `${base}/api/chat`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Ollama request failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      message?: { content?: string };
    };
    const text = data.message?.content;
    if (!text) {
      throw new Error('Ollama returned an empty response');
    }

    return parseResponse(text);
  }
}
