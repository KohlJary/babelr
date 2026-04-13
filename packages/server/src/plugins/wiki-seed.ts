// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { eq, and } from 'drizzle-orm';
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
 * Seed the default Babelr server's wiki with the built-in user
 * manual on first boot. Runs once — if any wiki pages already
 * exist on the default server, the seeder is a no-op.
 *
 * The manual lives in packages/server/src/db/seed-data/wiki/ as
 * markdown files described by a manifest.json. Each page gets a
 * chat collection for comments and a revision 1 entry.
 */
async function wikiSeedPlugin(fastify: FastifyInstance) {
  fastify.addHook('onReady', async () => {
    const db = fastify.db;
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';

    // Find the default Babelr server.
    const serverUri = `${protocol}://${config.domain}/groups/babelr`;
    const [server] = await db
      .select()
      .from(actors)
      .where(and(eq(actors.uri, serverUri), eq(actors.type, 'Group')))
      .limit(1);
    if (!server) return;

    // Check if wiki pages already exist — don't re-seed.
    const [existing] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.serverId, server.id))
      .limit(1);
    if (existing) return;

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

    // First pass: create all pages (without parent references).
    const slugToId = new Map<string, string>();

    for (const entry of manifest.pages) {
      const filePath = join(seedDir, entry.file);
      if (!existsSync(filePath)) {
        fastify.log.warn({ file: entry.file }, 'Wiki seed file not found');
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const pageUri = `${protocol}://${config.domain}/servers/${server.id}/wiki/${entry.slug}`;

      // Create chat collection.
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
          serverId: server.id,
          uri: pageUri,
          slug: entry.slug,
          title: entry.title,
          content,
          tags: [],
          position: entry.position ?? 0,
          chatId: chatChannel.id,
          createdById: server.id,
          lastEditedById: server.id,
        })
        .returning();

      slugToId.set(entry.slug, page.id);

      // Create initial revision.
      await db.insert(wikiPageRevisions).values({
        pageId: page.id,
        revisionNumber: 1,
        title: entry.title,
        content,
        editedById: server.id,
        summary: 'Initial seed',
      });
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

    fastify.log.info(
      { count: slugToId.size },
      'Wiki manual seeded on default server',
    );
  });
}

export default fp(wikiSeedPlugin, {
  name: 'wiki-seed',
  dependencies: ['db', 'seed'],
});
