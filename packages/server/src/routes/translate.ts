// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import type {
  TranslateProxyRequest,
  TranslateProxyResponse,
  TranslationResult,
} from '@babelr/shared';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 8192;
const MAX_BATCH_SIZE = 100;

function buildPrompt(
  messages: { id: string; content: string }[],
  targetLanguage: string,
  sourceLanguage?: string,
): string {
  const sourceHint = sourceLanguage ? ` The source language is likely ${sourceLanguage}.` : '';
  const messageList = messages.map((m) => `[${m.id}]: ${m.content}`).join('\n');

  return `You are a tone-preserving translation engine. For each message below, execute this pipeline internally:

STAGE 1 - CLASSIFY: Determine the register and intent of the source text.
- Register: one of "casual", "formal", "sarcastic", "technical", "affectionate", "neutral"
- Intent: one of "statement", "question", "joke", "correction", "greeting", "reference"

STAGE 2 - TRANSLATE: Translate to ${targetLanguage} using the classified register and intent as explicit constraints.${sourceHint}
- Preserve the emotional tone and conversational register, not just lexical meaning.
- If the source is a joke, the translation must function as a joke in ${targetLanguage}.
- If the source is sarcastic, the translation must read as sarcastic in ${targetLanguage}.
- If the source is affectionate, preserve the warmth and intimacy level.
- Do NOT flatten casual speech into formal language or vice versa.

STAGE 3 - IDIOM CHECK: Identify idioms, slang, cultural references, or expressions that lack direct equivalents in ${targetLanguage}.
- For each flagged expression: provide the original text, an explanation of its meaning, and a target-language equivalent if one exists.

If a message is already in ${targetLanguage}, return it unchanged with skipped: true. Still classify its register and intent.

Return ONLY a JSON array. Each element must have exactly these fields:
- "id": the message id (string, preserve exactly as given)
- "translatedContent": the translated text (string)
- "detectedLanguage": ISO 639-1 language code of the source (string)
- "skipped": true if source language matches ${targetLanguage}, false otherwise (boolean)
- "metadata": object with:
  - "register": one of "casual", "formal", "sarcastic", "technical", "affectionate", "neutral"
  - "intent": one of "statement", "question", "joke", "correction", "greeting", "reference"
  - "confidence": number 0-1, your confidence in translation quality (1.0 for skipped messages)
  - "idioms": array of objects, each with "original" (string), "explanation" (string), and optionally "equivalent" (string). Empty array if no idioms detected.

Messages:
${messageList}

Respond with ONLY the JSON array. No markdown fences, no explanation.`;
}

const VALID_REGISTERS = new Set([
  'casual',
  'formal',
  'sarcastic',
  'technical',
  'affectionate',
  'neutral',
]);
const VALID_INTENTS = new Set([
  'statement',
  'question',
  'joke',
  'correction',
  'greeting',
  'reference',
]);

function parseResponse(text: string): TranslationResult[] {
  // Strip markdown code fences if the model wrapped the response
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const results = JSON.parse(cleaned) as TranslationResult[];

  // Validate and normalize metadata
  for (const r of results) {
    if (r.metadata) {
      if (!VALID_REGISTERS.has(r.metadata.register)) {
        r.metadata.register = 'neutral';
      }
      if (!VALID_INTENTS.has(r.metadata.intent)) {
        r.metadata.intent = 'statement';
      }
      if (
        typeof r.metadata.confidence !== 'number' ||
        r.metadata.confidence < 0 ||
        r.metadata.confidence > 1
      ) {
        r.metadata.confidence = 0.5;
      }
      if (!Array.isArray(r.metadata.idioms)) {
        r.metadata.idioms = [];
      }
    }
  }

  return results;
}

export default async function translateRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: TranslateProxyRequest }>('/translate', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { apiKey, messages, targetLanguage, sourceLanguage } = request.body;

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

    const prompt = buildPrompt(messages, targetLanguage, sourceLanguage);

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
