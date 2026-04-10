// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Dump precomputed UI translations from the database into a JSON file
 * checked into the repo. The boot-time seed plugin reads this file on
 * server start and upserts it into ui_translations, so fresh deployments
 * arrive pre-populated and existing deployments pick up new strings on
 * the next restart.
 *
 * Workflow when adding new strings:
 *   1. Edit packages/shared/src/i18n/strings.ts
 *   2. npm run seed:i18n -w packages/server   (translates new strings)
 *   3. npm run dump:i18n -w packages/server   (regenerates the JSON)
 *   4. Commit packages/server/src/db/seed-data/ui-translations.json
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx packages/server/src/scripts/dump-ui-translations.ts
 *
 * Or via npm script:
 *   npm run dump:i18n -w packages/server
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { createDb } from '../db/index.ts';
import { uiTranslations } from '../db/schema/ui-translations.ts';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const db = createDb(dbUrl);

  const rows = await db
    .select({
      lang: uiTranslations.lang,
      key: uiTranslations.key,
      value: uiTranslations.value,
    })
    .from(uiTranslations)
    .orderBy(asc(uiTranslations.lang), asc(uiTranslations.key));

  // Group by language for compactness and stable diffs
  const byLang: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (!byLang[row.lang]) byLang[row.lang] = {};
    byLang[row.lang][row.key] = row.value;
  }

  // Sort keys within each language for stable diffs
  const sorted: Record<string, Record<string, string>> = {};
  for (const lang of Object.keys(byLang).sort()) {
    sorted[lang] = {};
    for (const key of Object.keys(byLang[lang]).sort()) {
      sorted[lang][key] = byLang[lang][key];
    }
  }

  // Write next to the schema/migrations
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outDir = `${__dirname}/../db/seed-data`;
  const outPath = `${outDir}/ui-translations.json`;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');

  const totalRows = rows.length;
  const totalLangs = Object.keys(sorted).length;
  console.log(`Dumped ${totalRows} translations across ${totalLangs} languages → ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
