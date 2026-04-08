// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import type { TranslateProxyRequest, TranslateProxyResponse } from '@babelr/shared';
import { buildPrompt, parseResponse } from '../benchmark/prompt.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 8192;
const MAX_BATCH_SIZE = 100;

export default async function translateRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: TranslateProxyRequest }>('/translate', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { apiKey, messages, targetLanguage, sourceLanguage, glossary } = request.body;

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

    const prompt = buildPrompt(messages, targetLanguage, sourceLanguage, glossary);

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        const status = res.status === 401 ? 401 : 502;
        const message = res.status === 401 ? 'Invalid API key' : 'Translation service error';
        fastify.log.error({ status: res.status, body: errorBody }, 'Anthropic API error');
        return reply.status(status).send({ error: message });
      }

      const data = (await res.json()) as {
        content: { type: string; text: string }[];
      };

      const text = data.content?.[0]?.text;
      if (!text) {
        return reply.status(502).send({ error: 'Empty response from translation service' });
      }

      const results = parseResponse(text);

      const response: TranslateProxyResponse = { results };
      return response;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return reply.status(502).send({ error: 'Failed to parse translation response' });
      }
      fastify.log.error(err, 'Translation proxy error');
      return reply.status(502).send({ error: 'Translation service unavailable' });
    }
  });
}
