// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { uiTranslations } from '../db/schema/ui-translations.ts';
import { UI_STRINGS, SUPPORTED_LANGUAGES } from '@babelr/shared';

export default async function i18nRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get<{ Params: { lang: string } }>(
    '/i18n/:lang',
    async (request, reply) => {
      const lang = request.params.lang;

      if (!SUPPORTED_LANGUAGES.includes(lang as (typeof SUPPORTED_LANGUAGES)[number])) {
        return reply.status(404).send({ error: 'Language not supported' });
      }

      // English is just the master strings file — never stored.
      if (lang === 'en') {
        reply.header('Cache-Control', 'public, max-age=300');
        return UI_STRINGS;
      }

      const rows = await db
        .select({ key: uiTranslations.key, value: uiTranslations.value })
        .from(uiTranslations)
        .where(eq(uiTranslations.lang, lang));

      // Build dict, falling back to English for any missing keys
      const dict: Record<string, string> = { ...UI_STRINGS };
      for (const row of rows) {
        dict[row.key] = row.value;
      }

      reply.header('Cache-Control', 'public, max-age=300');
      return dict;
    },
  );
}
