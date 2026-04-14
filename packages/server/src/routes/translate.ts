// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import type {
  TranslateProxyRequest,
  TranslateProxyResponse,
  ProxyProviderKind,
} from '@babelr/shared';
import { buildPrompt, parseResponse, maskEmbeds, restoreEmbeds } from '@babelr/shared';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

const MAX_TOKENS = 8192;
const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Adapter result shape: either the raw response text to hand off to
 * `parseResponse`, or a `{ status, error }` pair that the caller
 * should send back to the client verbatim.
 */
type AdapterResult = { ok: true; text: string } | { ok: false; status: number; error: string };

/**
 * Anthropic adapter. Uses the user-supplied API key and hits the
 * Claude Messages API. 401 surfaces as 'Invalid API key'; anything
 * else maps to 502.
 */
async function callAnthropic(prompt: string, apiKey: string, signal: AbortSignal): Promise<AdapterResult> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status === 401 ? 401 : 502,
      error: res.status === 401 ? 'Invalid API key' : 'Translation service error',
    };
  }

  const data = (await res.json()) as { content: { type: string; text: string }[] };
  const text = data.content?.[0]?.text;
  if (!text) {
    return { ok: false, status: 502, error: 'Empty response from translation service' };
  }
  return { ok: true, text };
}

/**
 * OpenAI adapter. Uses the chat-completions endpoint with the same
 * three-stage prompt. Default model is gpt-4o-mini for cost; that's
 * the cheapest OpenAI model that handles the full classify-translate-
 * idiom pipeline reliably.
 */
async function callOpenAI(prompt: string, apiKey: string, signal: AbortSignal): Promise<AdapterResult> {
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      // We want JSON output — OpenAI's response_format enforces it.
      response_format: { type: 'json_object' },
    }),
    signal,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status === 401 ? 401 : 502,
      error: res.status === 401 ? 'Invalid API key' : 'Translation service error',
    };
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    return { ok: false, status: 502, error: 'Empty response from translation service' };
  }
  // OpenAI's response_format: json_object wraps arrays in a top-level
  // object, so we either get `{"results":[...]}` or the raw array.
  // parseResponse handles both — it extracts the first balanced array
  // from anywhere in the text.
  return { ok: true, text };
}

export default async function translateRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: TranslateProxyRequest }>('/translate', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { apiKey, messages, targetLanguage, sourceLanguage, glossary } = request.body;
    const provider: ProxyProviderKind = request.body.provider ?? 'anthropic';

    if (!apiKey || typeof apiKey !== 'string') {
      return reply.status(400).send({ error: 'API key is required' });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'Messages array is required' });
    }

    if (messages.length > MAX_BATCH_SIZE) {
      return reply.status(400).send({ error: `Maximum ${MAX_BATCH_SIZE} messages per batch` });
    }

    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return reply.status(400).send({ error: 'Target language is required' });
    }

    if (provider !== 'anthropic' && provider !== 'openai') {
      return reply.status(400).send({ error: `Unsupported proxy provider: ${provider}` });
    }

    // Mask [[kind:slug]] embed refs before translation so the LLM
    // doesn't translate slugs or rewrite bracket syntax. Restored on
    // the response side keyed by message id.
    const maskedById = new Map<string, string[]>();
    const maskedMessages = messages.map((m) => {
      const { masked, tokens } = maskEmbeds(m.content);
      maskedById.set(m.id, tokens);
      return { id: m.id, content: masked };
    });
    const prompt = buildPrompt(maskedMessages, targetLanguage, sourceLanguage, glossary);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const result =
        provider === 'openai'
          ? await callOpenAI(prompt, apiKey, signal)
          : await callAnthropic(prompt, apiKey, signal);

      if (!result.ok) {
        if (result.status >= 500) {
          fastify.log.error({ provider, status: result.status }, 'Translation provider error');
        }
        return reply.status(result.status).send({ error: result.error });
      }

      const results = parseResponse(result.text).map((r) => {
        const tokens = maskedById.get(r.id);
        return tokens && tokens.length > 0
          ? { ...r, translatedContent: restoreEmbeds(r.translatedContent, tokens) }
          : r;
      });
      const response: TranslateProxyResponse = { results };
      return response;
    } catch (err) {
      if (err instanceof SyntaxError) {
        fastify.log.error(err, 'Translation response parse error');
        return reply.status(502).send({ error: 'Failed to parse translation response' });
      }
      fastify.log.error(err, 'Translation proxy error');
      return reply.status(502).send({ error: 'Translation service unavailable' });
    }
  });
}
