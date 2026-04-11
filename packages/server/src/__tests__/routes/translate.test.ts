// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;
let cookie: string;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await cleanDb(db);
  const user = await createTestUser(app, 'alice');
  cookie = user.cookie;
  vi.restoreAllMocks();
});

/**
 * A canonical well-formed response from the three-stage prompt. Used
 * by both adapter tests; we just wrap it differently per provider
 * because Anthropic and OpenAI have different response envelopes.
 */
const promptResults = [
  {
    id: '1',
    translatedContent: 'Hello world',
    detectedLanguage: 'es',
    skipped: false,
    metadata: {
      register: 'casual',
      intent: 'greeting',
      confidence: 0.92,
      idioms: [],
    },
  },
];

function stubAnthropicFetch(status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(promptResults) }],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    ),
  );
}

function stubOpenAIFetch(status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify({ results: promptResults }) },
          },
        ],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('POST /translate', () => {
  describe('Anthropic adapter (default provider)', () => {
    it('calls the Anthropic messages endpoint with the user-supplied key', async () => {
      const fetchSpy = stubAnthropicFetch();
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: {
          apiKey: 'sk-ant-test',
          messages: [{ id: '1', content: 'Hola mundo' }],
          targetLanguage: 'en',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].translatedContent).toBe('Hello world');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBeTruthy();
      const reqBody = JSON.parse((init as RequestInit).body as string);
      expect(reqBody.model).toMatch(/^claude/);
    });

    it('still works when provider is omitted (back-compat with old clients)', async () => {
      stubAnthropicFetch();
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: {
          apiKey: 'sk-ant-test',
          messages: [{ id: '1', content: 'Hola' }],
          targetLanguage: 'en',
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('surfaces 401 from Anthropic as a 401 with Invalid API key', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"error":{}}', { status: 401 }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: {
          apiKey: 'bad',
          messages: [{ id: '1', content: 'Hi' }],
          targetLanguage: 'en',
          provider: 'anthropic',
        },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Invalid API key');
    });
  });

  describe('OpenAI adapter', () => {
    it('calls the OpenAI chat-completions endpoint with a bearer token', async () => {
      const fetchSpy = stubOpenAIFetch();
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: {
          apiKey: 'sk-openai-test',
          messages: [{ id: '1', content: 'Hola mundo' }],
          targetLanguage: 'en',
          provider: 'openai',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results[0].translatedContent).toBe('Hello world');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-openai-test');
      const reqBody = JSON.parse((init as RequestInit).body as string);
      expect(reqBody.model).toMatch(/^gpt/);
      expect(reqBody.response_format).toEqual({ type: 'json_object' });
    });
  });

  describe('validation', () => {
    it('rejects an unsupported provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: {
          apiKey: 'x',
          messages: [{ id: '1', content: 'Hi' }],
          targetLanguage: 'en',
          provider: 'ollama', // ollama is client-side only
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Unsupported/);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        payload: {
          apiKey: 'x',
          messages: [{ id: '1', content: 'Hi' }],
          targetLanguage: 'en',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a batch larger than the cap', async () => {
      const messages = Array.from({ length: 101 }, (_, i) => ({ id: String(i), content: 'Hi' }));
      const res = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { cookie },
        payload: { apiKey: 'x', messages, targetLanguage: 'en' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
