// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { buildPrompt, parseResponse } from '@babelr/shared';

describe('buildPrompt', () => {
  it('includes target language and message list', () => {
    const out = buildPrompt(
      [
        { id: '1', content: 'Hola mundo' },
        { id: '2', content: 'Good morning' },
      ],
      'en',
    );
    expect(out).toContain('Translate to en');
    expect(out).toContain('[1]: Hola mundo');
    expect(out).toContain('[2]: Good morning');
    expect(out).toContain('classified register and intent');
  });

  it('inlines the glossary when provided', () => {
    const out = buildPrompt([{ id: '1', content: 'hi' }], 'en', undefined, {
      K8s: 'Kubernetes',
      PR: 'pull request',
    });
    expect(out).toContain('GLOSSARY:');
    expect(out).toContain('"K8s" → "Kubernetes"');
    expect(out).toContain('"PR" → "pull request"');
  });

  it('adds a source-language hint when provided', () => {
    const out = buildPrompt([{ id: '1', content: 'bonjour' }], 'en', 'fr');
    expect(out).toContain('source language is likely fr');
  });
});

describe('parseResponse', () => {
  const goodEntry = {
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
  };

  it('parses a plain JSON array', () => {
    const out = parseResponse(JSON.stringify([goodEntry]));
    expect(out).toHaveLength(1);
    expect(out[0].translatedContent).toBe('Hello world');
  });

  it('strips markdown code fences (with language tag)', () => {
    const raw = '```json\n' + JSON.stringify([goodEntry]) + '\n```';
    const out = parseResponse(raw);
    expect(out[0].id).toBe('1');
  });

  it('strips markdown code fences without language tag', () => {
    const raw = '```\n' + JSON.stringify([goodEntry]) + '\n```';
    expect(parseResponse(raw)[0].id).toBe('1');
  });

  it('extracts a JSON array embedded in prose (OpenAI fallback, no response_format)', () => {
    const raw = `Sure! Here's the translation:\n\n${JSON.stringify([goodEntry])}\n\nLet me know if you need anything else!`;
    const out = parseResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].translatedContent).toBe('Hello world');
  });

  it('extracts a JSON array from inside a JSON object (OpenAI json_object mode)', () => {
    const raw = JSON.stringify({ results: [goodEntry] });
    // parseResponse finds the inner array even when wrapped in an object.
    const out = parseResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('1');
  });

  it('tolerates trailing commas (local models sometimes emit them)', () => {
    const raw = `[${JSON.stringify(goodEntry)},]`;
    const out = parseResponse(raw);
    expect(out).toHaveLength(1);
  });

  it('does not get confused by bracket characters inside string values', () => {
    const tricky = {
      ...goodEntry,
      translatedContent: 'The array [1, 2, 3] is here',
    };
    const out = parseResponse(JSON.stringify([tricky]));
    expect(out).toHaveLength(1);
    expect(out[0].translatedContent).toBe('The array [1, 2, 3] is here');
  });

  it('coerces invalid register to neutral', () => {
    const bad = { ...goodEntry, metadata: { ...goodEntry.metadata, register: 'hostile' } };
    const out = parseResponse(JSON.stringify([bad]));
    expect(out[0].metadata?.register).toBe('neutral');
  });

  it('coerces invalid intent to statement', () => {
    const bad = { ...goodEntry, metadata: { ...goodEntry.metadata, intent: 'demand' } };
    const out = parseResponse(JSON.stringify([bad]));
    expect(out[0].metadata?.intent).toBe('statement');
  });

  it('clamps out-of-range confidence to 0.5', () => {
    const bad = { ...goodEntry, metadata: { ...goodEntry.metadata, confidence: 2.5 } };
    const out = parseResponse(JSON.stringify([bad]));
    expect(out[0].metadata?.confidence).toBe(0.5);
  });

  it('ensures idioms is always an array', () => {
    const bad = {
      ...goodEntry,
      metadata: { ...goodEntry.metadata, idioms: null as unknown as [] },
    };
    const out = parseResponse(JSON.stringify([bad]));
    expect(out[0].metadata?.idioms).toEqual([]);
  });

  it('throws SyntaxError on unrecoverable garbage', () => {
    expect(() => parseResponse('not json at all, {invalid')).toThrow(SyntaxError);
  });
});
