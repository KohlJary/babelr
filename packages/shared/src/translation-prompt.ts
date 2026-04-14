// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult } from './types/translation.js';

/**
 * Canonical tone-preserving translation prompt. Shared by every
 * LLM backend (Anthropic, OpenAI, Ollama) so they all produce the
 * same response shape and the quality comparison is apples-to-apples.
 *
 * The Transformers.js provider bypasses this entirely — OPUS models
 * are purpose-built translators, they don't take instructions, and
 * they don't produce register/idiom metadata.
 */

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

export function buildPrompt(
  messages: { id: string; content: string }[],
  targetLanguage: string,
  sourceLanguage?: string,
  glossary?: Record<string, string>,
): string {
  const sourceHint = sourceLanguage ? ` The source language is likely ${sourceLanguage}.` : '';
  const messageList = messages.map((m) => `[${m.id}]: ${m.content}`).join('\n');
  const glossarySection =
    glossary && Object.keys(glossary).length > 0
      ? `\n\nGLOSSARY: The following terms have specific meanings in this channel. Use these translations:\n${Object.entries(
          glossary,
        )
          .map(([term, meaning]) => `- "${term}" → "${meaning}"`)
          .join('\n')}`
      : '';

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
- Tokens that look like ⟦E0⟧, ⟦E1⟧, etc. are placeholders for embedded references. Copy them through verbatim — do NOT translate, modify, or reorder them.

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
${messageList}${glossarySection}

Respond with ONLY the JSON array. No markdown fences, no explanation.`;
}

/**
 * Parse a raw LLM response into an array of TranslationResult. Handles
 * the common ways Anthropic, OpenAI, and Ollama wrap their JSON output:
 *
 * - Leading/trailing whitespace
 * - Markdown code fences (\`\`\`json ... \`\`\`)
 * - Leading prose like "Here is the translation:" or "Sure! ..."
 * - Trailing prose after the closing bracket
 *
 * Extracts the first balanced JSON array from the text. If parsing
 * still fails, throws a SyntaxError — the caller decides whether to
 * retry or surface the error.
 *
 * Validates per-entry metadata fields and coerces invalid values to
 * safe defaults so downstream UI never sees a garbage register/intent.
 */
export function parseResponse(text: string): TranslationResult[] {
  let cleaned = text.trim();

  // Strip markdown code fences first — the most common wrapper.
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract the outermost JSON array from anywhere in the payload.
  // Walks the string and tracks bracket depth so nested arrays don't
  // confuse it. This lets us handle prefix prose ("Here's the JSON:")
  // and trailing prose ("Hope that helps!") without a regex dance.
  const arrayRange = findJsonArrayRange(cleaned);
  if (arrayRange) {
    cleaned = cleaned.slice(arrayRange.start, arrayRange.end + 1);
  }

  // Remove trailing commas before } or ] — some local models emit them
  // even when told not to.
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  const results = JSON.parse(cleaned) as TranslationResult[];
  if (!Array.isArray(results)) {
    throw new SyntaxError('Translation response was not a JSON array');
  }

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

/**
 * Find the outermost balanced `[...]` range in a text blob. Returns
 * inclusive start/end indices of the matching brackets, or null if no
 * balanced pair exists. Tracks string-literal state to avoid counting
 * brackets that live inside string values.
 */
function findJsonArrayRange(text: string): { start: number; end: number } | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return { start, end: i };
      }
    }
  }
  return null;
}
