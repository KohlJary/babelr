// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Precomputed UI string translations. Each row is one (language, key) pair.
 *
 * Populated via the `seed:i18n` script which calls Anthropic to translate
 * the master strings file (packages/shared/src/i18n/strings.ts) into every
 * supported language. The client fetches a full dict per language at session
 * start via GET /i18n/:lang.
 */
export const uiTranslations = pgTable(
  'ui_translations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lang: varchar('lang', { length: 16 }).notNull(),
    key: varchar('key', { length: 128 }).notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ui_translations_lang_key_idx').on(table.lang, table.key),
    index('ui_translations_lang_idx').on(table.lang),
  ],
);
