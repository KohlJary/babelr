// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult } from '@babelr/shared';
import { buildPrompt, parseResponse } from './prompt.ts';
import type { TestCase } from './test-cases.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 8192;

export const MODEL_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-1-20250805',
  haiku: 'claude-haiku-4-5-20251001',
};

export interface RunResult {
  model: string;
  modelId: string;
  targetLanguage: string;
  results: TranslationResult[];
  durationMs: number;
  error?: string;
}

export async function runTranslation(
  apiKey: string,
  modelName: string,
  cases: TestCase[],
  targetLanguage: string,
): Promise<RunResult> {
  const modelId = MODEL_MAP[modelName];
  if (!modelId) {
    return {
      model: modelName,
      modelId: 'unknown',
      targetLanguage,
      results: [],
      durationMs: 0,
      error: `Unknown model: ${modelName}. Available: ${Object.keys(MODEL_MAP).join(', ')}`,
    };
  }

  const messages = cases.map((c) => ({ id: c.id, content: c.content }));
  const prompt = buildPrompt(messages, targetLanguage);

  const start = performance.now();

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const durationMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const errorBody = await res.text();
      return {
        model: modelName,
        modelId,
        targetLanguage,
        results: [],
        durationMs,
        error: `API error ${res.status}: ${errorBody.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };

    const text = data.content?.[0]?.text;
    if (!text) {
      return {
        model: modelName,
        modelId,
        targetLanguage,
        results: [],
        durationMs,
        error: 'Empty response from API',
      };
    }

    const results = parseResponse(text);
    return { model: modelName, modelId, targetLanguage, results, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    return {
      model: modelName,
      modelId,
      targetLanguage,
      results: [],
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
