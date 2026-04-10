// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Seed UI string translations into the database.
 *
 * For each non-English supported language, batches all UI strings into a
 * single Anthropic Haiku call requesting a JSON dict back. Upserts the
 * results into ui_translations.
 *
 * Re-runnable: existing rows are updated in place via ON CONFLICT, and
 * adding new keys to the master strings file just produces additional
 * inserts on the next run.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... \
 *     npx tsx packages/server/src/scripts/seed-ui-translations.ts
 *
 * Or via npm script:
 *   npm run seed:i18n -w packages/server
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../db/index.ts';
import { uiTranslations } from '../db/schema/ui-translations.ts';
import { UI_STRINGS, SUPPORTED_LANGUAGES } from '@babelr/shared';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  vi: 'Vietnamese',
};

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function translateBatch(
  apiKey: string,
  targetLang: string,
  strings: Record<string, string>,
): Promise<Record<string, string>> {
  const targetName = LANGUAGE_NAMES[targetLang] ?? targetLang;
  const systemPrompt = `You are a UI localization translator. You will receive a JSON object of English UI strings keyed by stable identifiers, and you must return a JSON object with the same keys whose values are translations into ${targetName}.

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary.
- Preserve exactly the same keys as the input.
- Translate the values naturally for the target language and the chat-app context.
- Keep placeholders, variable substitutions, and formatting marks intact.
- Keep brand names like "Babelr", "Claude", "Anthropic" untranslated.
- Match the register and tone of the source (concise, friendly, professional UI copy).
- For very short strings (single words like "Save"), use the natural UI convention in the target language, not a literal dictionary translation.`;

  const userPrompt = `Translate this UI strings dict into ${targetName}:\n\n${JSON.stringify(strings, null, 2)}`;

  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as AnthropicMessageResponse;
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';

  // Strip any accidental code fences
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Failed to parse translation JSON for ${targetLang}: ${err instanceof Error ? err.message : String(err)}\nResponse:\n${text.slice(0, 500)}`,
    );
  }

  // Sanity check: verify all source keys are present
  const missing = Object.keys(strings).filter((k) => !(k in parsed));
  if (missing.length > 0) {
    console.warn(
      `[${targetLang}] Warning: ${missing.length} key(s) missing from response, will fall back to English: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
    );
  }

  return parsed;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const db = createDb(dbUrl);
  const sourceStrings = UI_STRINGS as Record<string, string>;
  const totalKeys = Object.keys(sourceStrings).length;
  const targets = SUPPORTED_LANGUAGES.filter((l) => l !== 'en');

  console.log(`Seeding UI translations: ${totalKeys} strings × ${targets.length} languages`);
  console.log(`Languages: ${targets.join(', ')}`);
  console.log('');

  for (const lang of targets) {
    process.stdout.write(`[${lang}] translating ${totalKeys} strings... `);
    const start = Date.now();

    try {
      const translated = await translateBatch(apiKey, lang, sourceStrings);
      const validRows = Object.entries(translated)
        .filter(([k, v]) => k in sourceStrings && typeof v === 'string' && v.length > 0)
        .map(([key, value]) => ({ lang, key, value }));

      // Upsert in chunks (Postgres has parameter limits)
      const CHUNK_SIZE = 100;
      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE);
        await db
          .insert(uiTranslations)
          .values(chunk)
          .onConflictDoUpdate({
            target: [uiTranslations.lang, uiTranslations.key],
            set: {
              value: sql`excluded.value`,
              updatedAt: sql`now()`,
            },
          });
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✓ ${validRows.length} rows in ${elapsed}s`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('');
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
