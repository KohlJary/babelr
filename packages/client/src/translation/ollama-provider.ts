// SPDX-License-Identifier: Hippocratic-3.0
import { buildPrompt, parseResponse, type TranslationResult } from '@babelr/shared';
import type { TranslationProvider, TranslationProgressCallback } from './types';

const DEFAULT_MODEL = 'llama3.1:8b';
/**
 * Per-item timeout. We process items sequentially (see translate()
 * below), so this is the budget for one chunk of prose, not the whole
 * batch. 90s is generous enough for an 8B model on CPU to finish a
 * paragraph with full classify-translate-idiom metadata.
 */
const PER_ITEM_TIMEOUT_MS = 90_000;

/**
 * Ollama-backed translation provider. Unlike the Anthropic and OpenAI
 * providers, this hits the user's Ollama instance **directly from the
 * browser** — the Babelr server is not involved at all. That's
 * deliberate: the whole point of Ollama support is the enterprise
 * air-gap / self-hosted story where the server shouldn't be in the
 * translation path.
 *
 * **Why we do not batch.** The Anthropic and OpenAI adapters pass the
 * whole batch to a single API call because their underlying models
 * handle N-element JSON arrays with metadata effortlessly. Ollama's
 * typical targets (7B/8B instruction models on consumer hardware) do
 * not. They stall on long structured outputs, especially when we
 * also ask them to classify register/intent and flag idioms for each
 * item — the generation time scales superlinearly with output length
 * and often blows past any reasonable timeout.
 *
 * So this provider splits the batch into single-item requests and
 * runs them sequentially. Each prompt asks the model to translate
 * exactly one paragraph, which is the shape small models are good
 * at. Total wall-clock time is roughly `N * per_item_time`, but the
 * per-item time is predictable and each item completes cleanly.
 *
 * **Why we don't set `format: 'json'`.** Ollama's JSON-constrained
 * decoding is 2-5x slower on small models and occasionally produces
 * invalid output when combined with a complex prompt. The shared
 * `parseResponse` helper already extracts JSON from prose wrappers,
 * so we don't need the constraint — we just need the model to emit
 * JSON somewhere in its response, which the prompt makes very clear.
 *
 * **CORS.** The user's Ollama instance must allow the Babelr origin.
 * Ollama 0.1.23+ respects `OLLAMA_ORIGINS`; for local dev, running
 * `OLLAMA_ORIGINS='*' ollama serve` is the simplest path. In
 * enterprise deployments the reverse proxy in front of Ollama
 * typically handles CORS.
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
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    // Normalize the base URL once — people paste it with or without
    // trailing slash, sometimes with /api already appended.
    const base = this.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const url = `${base}/api/chat`;

    const results: TranslationResult[] = [];

    for (const msg of messages) {
      const prompt = buildPrompt([msg], targetLanguage, sourceLanguage);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(PER_ITEM_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new Error(
            `Ollama timed out after ${PER_ITEM_TIMEOUT_MS / 1000}s translating one item with model "${this.model}". ` +
              `Try a smaller model (e.g. llama3.2:3b) or check that Ollama is not overloaded.`,
          );
        }
        throw err;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Ollama request failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
        );
      }

      const data = (await res.json()) as { message?: { content?: string } };
      const text = data.message?.content;
      if (!text) {
        throw new Error('Ollama returned an empty response');
      }

      // parseResponse returns an array even for a single-item batch;
      // flatten back out so we accumulate one-per-item.
      const parsed = parseResponse(text);
      if (parsed.length === 0) {
        throw new Error('Ollama response did not contain a JSON array');
      }
      // If the model somehow emitted multiple entries, keep only the
      // first and force its id back to the source id we asked for —
      // some small models rewrite the id field to arbitrary strings.
      const result = { ...parsed[0], id: msg.id };
      results.push(result);
      onProgress?.(result);
    }

    return results;
  }
}
