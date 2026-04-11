// SPDX-License-Identifier: Hippocratic-3.0
import { and, eq, inArray } from 'drizzle-orm';
import { extractWikiSlugs } from '@babelr/shared';
import { wikiPages, wikiPageLinks } from './db/schema/wiki.ts';
import { objects } from './db/schema/objects.ts';
import type { createDb } from './db/index.ts';

type Db = ReturnType<typeof createDb>;

/**
 * Find the server that owns the channel a message belongs to. A message
 * is an object with `context = channelObjectId`; the channel object's
 * `belongsTo` is the server (Group) actor id. Returns null for DMs or
 * messages in orphaned collections.
 */
async function serverIdForChannel(db: Db, channelId: string): Promise<string | null> {
  const [channel] = await db
    .select({ belongsTo: objects.belongsTo })
    .from(objects)
    .where(eq(objects.id, channelId))
    .limit(1);
  return channel?.belongsTo ?? null;
}

/**
 * Sync the outgoing wiki link rows for a message. Parses `[[slug]]`
 * refs out of the message's content, resolves them against the owning
 * server's wiki pages, and rewrites the rows where the message is the
 * source.
 *
 * Silently no-ops if the message is not in a server-owned channel
 * (DMs, user-scoped collections) — wiki pages are always server-scoped
 * so there's nothing to link against.
 */
export async function syncMessageOutboundLinks(
  db: Db,
  messageId: string,
  channelId: string,
  content: string,
): Promise<void> {
  const serverId = await serverIdForChannel(db, channelId);
  if (!serverId) return;

  // Clear prior rows even if content has no refs — the user may have
  // removed the ref in an edit.
  await db.delete(wikiPageLinks).where(eq(wikiPageLinks.sourceMessageId, messageId));

  const slugs = extractWikiSlugs(content);
  if (slugs.length === 0) return;

  const targets = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.serverId, serverId), inArray(wikiPages.slug, slugs)));
  if (targets.length === 0) return;

  await db.insert(wikiPageLinks).values(
    targets.map((t) => ({
      serverId,
      sourceType: 'message' as const,
      sourcePageId: null,
      sourceMessageId: messageId,
      targetType: 'page' as const,
      targetPageId: t.id,
      targetMessageId: null,
    })),
  );
}
