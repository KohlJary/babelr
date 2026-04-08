// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult } from '@babelr/shared';

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
  const glossarySection = glossary && Object.keys(glossary).length > 0
    ? `\n\nGLOSSARY: The following terms have specific meanings in this channel. Use these translations:\n${Object.entries(glossary).map(([term, meaning]) => `- "${term}" → "${meaning}"`).join('\n')}`
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

export function parseResponse(text: string): TranslationResult[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const results = JSON.parse(cleaned) as TranslationResult[];

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
