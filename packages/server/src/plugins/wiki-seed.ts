// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { eq, and, sql } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { wikiPages, wikiPageRevisions } from '../db/schema/wiki.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WikiManifestPage {
  slug: string;
  title: string;
  file: string;
  parent?: string;
  position?: number;
}

/**
 * The Babelr Manual is a Tower-level wiki that lives outside any
 * server. It's a read-only user guide seeded on first boot,
 * accessible from the server sidebar via a "Manual" link, and
 * referenceable from anywhere via `[[man:slug]]` embeds.
 *
 * The manual has its own system Group actor (`_manual`) so wiki
 * pages have a valid serverId FK. This actor is not discoverable,
 * not joinable, and not federated — it's purely an ownership
 * anchor for the manual pages.
 */
async function wikiSeedPlugin(fastify: FastifyInstance) {
  fastify.addHook('onReady', async () => {
    const db = fastify.db;
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const manualUri = `${protocol}://${config.domain}/system/manual`;

    // Upsert the system manual actor.
    let [manual] = await db
      .select()
      .from(actors)
      .where(eq(actors.uri, manualUri))
      .limit(1);

    if (!manual) {
      [manual] = await db
        .insert(actors)
        .values({
          type: 'Group',
          preferredUsername: '_manual',
          displayName: 'Babelr Manual',
          summary: 'Built-in user guide',
          uri: manualUri,
          inboxUri: `${manualUri}/inbox`,
          outboxUri: `${manualUri}/outbox`,
          followersUri: `${manualUri}/followers`,
          followingUri: `${manualUri}/following`,
          local: true,
          properties: { isManual: true },
        })
        .returning();
    }

    // Load the manifest.
    const seedDir = join(__dirname, '../db/seed-data/wiki');
    const manifestPath = join(seedDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      fastify.log.info('Wiki seed manifest not found; skipping');
      return;
    }

    let manifest: { pages: WikiManifestPage[] };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      fastify.log.error('Failed to parse wiki seed manifest');
      return;
    }

    // Upsert pages: create new ones, update existing seeded pages
    // if the source content has changed. Skip pages that have been
    // edited by a real user (lastEditedById !== manual.id) — those
    // are user-customized and should not be overwritten.
    const slugToId = new Map<string, string>();
    let created = 0;
    let updated = 0;

    for (const entry of manifest.pages) {
      const filePath = join(seedDir, entry.file);
      if (!existsSync(filePath)) {
        fastify.log.warn({ file: entry.file }, 'Wiki seed file not found');
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const pageUri = `${protocol}://${config.domain}/manual/wiki/${entry.slug}`;

      // Check if page already exists.
      const [existing] = await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.serverId, manual.id), eq(wikiPages.slug, entry.slug)))
        .limit(1);

      if (existing) {
        slugToId.set(entry.slug, existing.id);

        // Only update if the page was last edited by the system
        // (not a real user) AND the content has actually changed.
        if (existing.lastEditedById === manual.id && existing.content !== content) {
          await db
            .update(wikiPages)
            .set({
              title: entry.title,
              content,
              contentSearch: sql`to_tsvector('english', ${entry.title} || ' ' || ${content})`,
              position: entry.position ?? existing.position,
              updatedAt: new Date(),
            })
            .where(eq(wikiPages.id, existing.id));
          updated++;
        }
        continue;
      }

      // New page — create with chat collection.
      const chatUri = `${protocol}://${config.domain}/wiki/${crypto.randomUUID()}/chat`;
      const [chatChannel] = await db
        .insert(objects)
        .values({
          uri: chatUri,
          type: 'OrderedCollection',
          belongsTo: null,
          properties: { name: entry.title, isWikiChat: true },
        })
        .returning();

      const [page] = await db
        .insert(wikiPages)
        .values({
          serverId: manual.id,
          uri: pageUri,
          slug: entry.slug,
          title: entry.title,
          content,
          tags: [],
          position: entry.position ?? 0,
          chatId: chatChannel.id,
          contentSearch: sql`to_tsvector('english', ${entry.title} || ' ' || ${content})`,
          createdById: manual.id,
          lastEditedById: manual.id,
        })
        .returning();

      slugToId.set(entry.slug, page.id);

      await db.insert(wikiPageRevisions).values({
        pageId: page.id,
        revisionNumber: 1,
        title: entry.title,
        content,
        editedById: manual.id,
        summary: 'Initial seed',
      });
      created++;
    }

    // Second pass: set parent references.
    for (const entry of manifest.pages) {
      if (!entry.parent) continue;
      const pageId = slugToId.get(entry.slug);
      const parentId = slugToId.get(entry.parent);
      if (pageId && parentId) {
        await db
          .update(wikiPages)
          .set({ parentId })
          .where(eq(wikiPages.id, pageId));
      }
    }

    if (created > 0 || updated > 0) {
      fastify.log.info(
        { created, updated, total: slugToId.size },
        'Babelr Manual wiki seeded/updated',
      );
    }
  });
}

export default fp(wikiSeedPlugin, {
  name: 'wiki-seed',
  dependencies: ['db', 'seed'],
});
