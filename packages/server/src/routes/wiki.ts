// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, asc, desc, inArray, sql } from 'drizzle-orm';
import '../types.ts';
import { writeAuditLog } from '../audit.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { wikiPages, wikiPageRevisions, wikiPageLinks } from '../db/schema/wiki.ts';
import { toAuthorView } from '../serializers.ts';
import { extractWikiSlugs, PERMISSIONS } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { enqueueToFollowers, enqueueDelivery } from '../federation/delivery.ts';
import { serializeActivity } from '../federation/jsonld.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import type {
  WikiPageView,
  WikiPageSummary,
  WikiBacklinkView,
  WikiSettingsView,
  CreateWikiPageInput,
  UpdateWikiPageInput,
  UpdateWikiSettingsInput,
} from '@babelr/shared';

type Db = ReturnType<typeof import('../db/index.ts').createDb>;

/** Build a to_tsvector SQL expression for a wiki page's title + content. */
function buildSearchVector(title: string, content: string) {
  return sql`to_tsvector('english', ${title} || ' ' || ${content})`;
}

/**
 * Turn a user-supplied title into a URL-safe slug. Lowercased, ASCII
 * letters/digits/hyphens only, collapsed runs of non-alphanumerics to a
 * single hyphen, trimmed. Not unique on its own — the caller is
 * responsible for disambiguating collisions.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/**
 * Clean up a user-supplied tag list: trim whitespace, lowercase for
 * consistent matching, drop empties and exact duplicates, enforce a
 * per-tag length cap and a per-page tag count cap. Returns a fresh
 * array suitable for direct insertion into the `tags text[]` column.
 */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase().slice(0, 48);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 32) break; // per-page tag cap
  }
  return out;
}

async function ensureUniqueSlug(db: Db, serverId: string, base: string): Promise<string> {
  const seed = base || 'page';
  let candidate = seed;
  let n = 2;
  for (;;) {
    const [row] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.serverId, serverId), eq(wikiPages.slug, candidate)))
      .limit(1);
    if (!row) return candidate;
    candidate = `${seed}-${n}`.slice(0, 128);
    n += 1;
  }
}


async function toWikiPageView(
  db: Db,
  page: typeof wikiPages.$inferSelect,
): Promise<WikiPageView> {
  const [creator] = await db.select().from(actors).where(eq(actors.id, page.createdById)).limit(1);
  const [editor] = await db.select().from(actors).where(eq(actors.id, page.lastEditedById)).limit(1);
  const fallback = { id: page.createdById, preferredUsername: 'unknown', displayName: null, avatarUrl: null };
  return {
    id: page.id,
    serverId: page.serverId,
    slug: page.slug,
    title: page.title,
    content: page.content,
    tags: page.tags ?? [],
    parentId: page.parentId,
    position: page.position,
    chatId: page.chatId,
    createdBy: creator ? toAuthorView(creator) : fallback,
    lastEditedBy: editor ? toAuthorView(editor) : fallback,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

function toWikiPageSummary(
  page: typeof wikiPages.$inferSelect,
  editor: typeof actors.$inferSelect | undefined,
): WikiPageSummary {
  const fallback = { id: page.lastEditedById, preferredUsername: 'unknown', displayName: null, avatarUrl: null };
  return {
    id: page.id,
    serverId: page.serverId,
    slug: page.slug,
    title: page.title,
    tags: page.tags ?? [],
    parentId: page.parentId,
    position: page.position,
    lastEditedBy: editor ? toAuthorView(editor) : fallback,
    updatedAt: page.updatedAt.toISOString(),
  };
}

/**
 * Resolve a list of slugs to the wiki page rows they refer to within a
 * given server. Returns only pages that exist; unresolved slugs are
 * silently dropped — the link is re-synced whenever the source content
 * changes so a later-created target will pick up the reference on its
 * next edit.
 */
async function resolveWikiSlugs(
  db: Db,
  serverId: string,
  slugs: string[],
): Promise<typeof wikiPages.$inferSelect[]> {
  if (slugs.length === 0) return [];
  return db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.serverId, serverId), inArray(wikiPages.slug, slugs)));
}

/**
 * Rewrite the outgoing link rows for a wiki page. Called after a page
 * is created or updated. Deletes the page's existing outgoing rows and
 * inserts new ones based on the current parse of `[[slug]]` refs.
 * Message-sourced links are untouched — this only owns `sourcePageId`
 * rows.
 */
async function syncPageOutboundLinks(
  db: Db,
  serverId: string,
  pageId: string,
  content: string,
): Promise<void> {
  await db.delete(wikiPageLinks).where(eq(wikiPageLinks.sourcePageId, pageId));
  const slugs = extractWikiSlugs(content);
  if (slugs.length === 0) return;
  const targets = await resolveWikiSlugs(db, serverId, slugs);
  // Avoid self-loops — a page referencing its own slug is a no-op link.
  const rows = targets
    .filter((t) => t.id !== pageId)
    .map((t) => ({
      serverId,
      sourceType: 'page' as const,
      sourcePageId: pageId,
      sourceMessageId: null,
      targetType: 'page' as const,
      targetPageId: t.id,
      targetMessageId: null,
    }));
  if (rows.length > 0) {
    await db.insert(wikiPageLinks).values(rows);
  }
}

export default async function wikiRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // The manual is a system wiki accessible to all authenticated
  // users regardless of server membership. Cache the ID on first
  // check so we don't query every request.
  let manualActorId: string | null | undefined;
  async function isManualServer(serverId: string): Promise<boolean> {
    if (manualActorId === undefined) {
      const [manual] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.preferredUsername, '_manual'))
        .limit(1);
      manualActorId = manual?.id ?? null;
    }
    return manualActorId === serverId;
  }

  // List pages for a server
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/wiki/pages',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await isManualServer(request.params.serverId)) &&
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      // For remote servers, sync wiki pages from the origin so
      // newly created pages show up without re-joining.
      const [serverActor] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.params.serverId))
        .limit(1);
      if (serverActor && !serverActor.local) {
        try {
          const origin = new URL(serverActor.uri).origin;
          const slug = serverActor.preferredUsername;
          const pagesUrl = `${origin}/groups/${encodeURIComponent(slug)}/wiki/pages`;
          const res = await fetch(pagesUrl, {
            headers: { Accept: 'application/json', 'User-Agent': 'Babelr/0.1.0' },
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              pages: Array<{
                uri: string;
                slug: string;
                title: string;
                content: string;
                tags: string[];
                parentId?: string | null;
                position?: number;
              }>;
            };
            for (const p of data.pages ?? []) {
              if (!p.uri || !p.slug) continue;
              const [existing] = await db
                .select({ id: wikiPages.id })
                .from(wikiPages)
                .where(eq(wikiPages.uri, p.uri))
                .limit(1);
              if (existing) {
                await db
                  .update(wikiPages)
                  .set({ title: p.title, content: p.content, tags: p.tags, parentId: p.parentId ?? null, position: p.position ?? 0, contentSearch: buildSearchVector(p.title, p.content), updatedAt: new Date() })
                  .where(eq(wikiPages.id, existing.id));
              } else {
                await db.insert(wikiPages).values({
                  uri: p.uri,
                  serverId: serverActor.id,
                  slug: p.slug,
                  title: p.title,
                  content: p.content,
                  tags: p.tags,
                  parentId: p.parentId ?? null,
                  position: p.position ?? 0,
                  contentSearch: buildSearchVector(p.title, p.content),
                  createdById: serverActor.id,
                  lastEditedById: serverActor.id,
                }).onConflictDoNothing();
              }
            }
          }
        } catch {
          // Non-fatal — serve cached pages.
        }
      }

      const rows = await db
        .select()
        .from(wikiPages)
        .where(eq(wikiPages.serverId, request.params.serverId))
        .orderBy(asc(wikiPages.position), desc(wikiPages.updatedAt));

      // Batch-load editors to avoid N+1
      const editorIds = Array.from(new Set(rows.map((r) => r.lastEditedById)));
      const editors = editorIds.length
        ? await db.select().from(actors).where(inArray(actors.id, editorIds))
        : [];
      const editorMap = new Map(editors.map((e) => [e.id, e]));

      const pages: WikiPageSummary[] = rows.map((p) => toWikiPageSummary(p, editorMap.get(p.lastEditedById)));
      return { pages };
    },
  );

  // Full-text search across wiki page title + content
  fastify.get<{
    Params: { serverId: string };
    Querystring: { q?: string; limit?: string };
  }>(
    '/servers/:serverId/wiki/search',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await isManualServer(request.params.serverId)) &&
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const q = request.query.q?.trim();
      if (!q) return reply.status(400).send({ error: 'Search query is required' });

      const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
      const tsquery = q.split(/\s+/).join(' & ');

      const rows = await db
        .select({
          page: wikiPages,
          rank: sql<number>`ts_rank(${wikiPages.contentSearch}, to_tsquery('english', ${tsquery}))`,
        })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.serverId, request.params.serverId),
            sql`${wikiPages.contentSearch} @@ to_tsquery('english', ${tsquery})`,
          ),
        )
        .orderBy(sql`ts_rank DESC`)
        .limit(limit);

      // Load editors for results
      const editorIds = Array.from(new Set(rows.map((r) => r.page.lastEditedById)));
      const editors = editorIds.length
        ? await db.select().from(actors).where(inArray(actors.id, editorIds))
        : [];
      const editorMap = new Map(editors.map((e) => [e.id, e]));

      const results = rows.map((r) => ({
        ...toWikiPageSummary(r.page, editorMap.get(r.page.lastEditedById)),
        snippet: r.page.content.slice(0, 200),
        rank: r.rank,
      }));

      return { results };
    },
  );

  // Get a single page by slug
  fastify.get<{ Params: { serverId: string; slug: string } }>(
    '/servers/:serverId/wiki/pages/:slug',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await isManualServer(request.params.serverId)) &&
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.serverId, request.params.serverId),
            eq(wikiPages.slug, request.params.slug),
          ),
        )
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      return { page: await toWikiPageView(db, page) };
    },
  );

  // Create a page
  fastify.post<{ Params: { serverId: string }; Body: CreateWikiPageInput }>(
    '/servers/:serverId/wiki/pages',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.CREATE_WIKI_PAGES,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const body = request.body;
      if (!body?.title?.trim()) return reply.status(400).send({ error: 'title is required' });

      const baseSlug = slugify(body.slug?.trim() || body.title);
      if (!baseSlug) return reply.status(400).send({ error: 'title must produce a non-empty slug' });
      const slug = await ensureUniqueSlug(db, request.params.serverId, baseSlug);
      const content = body.content ?? '';

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';
      const pageUri = `${protocol}://${config.domain}/servers/${request.params.serverId}/wiki/${slug}`;

      // Create chat collection for the page's comment thread.
      const chatUri = `${protocol}://${config.domain}/wiki/${crypto.randomUUID()}/chat`;
      const [chatChannel] = await db
        .insert(objects)
        .values({
          uri: chatUri,
          type: 'OrderedCollection',
          belongsTo: null,
          properties: { name: body.title.trim(), isWikiChat: true },
        })
        .returning();

      const trimmedTitle = body.title.trim();
      const [created] = await db
        .insert(wikiPages)
        .values({
          serverId: request.params.serverId,
          uri: pageUri,
          slug,
          title: trimmedTitle,
          content,
          tags: normalizeTags(body.tags),
          parentId: body.parentId ?? null,
          position: body.position ?? 0,
          chatId: chatChannel.id,
          contentSearch: buildSearchVector(trimmedTitle, content),
          createdById: request.actor.id,
          lastEditedById: request.actor.id,
        })
        .returning();

      await db.insert(wikiPageRevisions).values({
        pageId: created.id,
        revisionNumber: 1,
        title: created.title,
        content: created.content,
        editedById: request.actor.id,
        summary: null,
      });

      await syncPageOutboundLinks(db, created.serverId, created.id, created.content);

      // Federation: deliver Create(Article).
      if (request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
        if (group) {
          const article = {
            type: 'Article',
            id: created.uri,
            name: created.title,
            content: created.content,
            slug: created.slug,
            tags: created.tags,
            parentId: created.parentId,
            position: created.position,
            attributedTo: request.actor.uri,
            context: group.uri,
          };
          const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            // Remote server: deliver to the origin Group's inbox.
            const activity = serializeActivity(activityUri, 'Create', request.actor.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, activity, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Wiki page remote federation failed'));
          } else {
            // Local server: fan out to Group followers.
            const activity = serializeActivity(activityUri, 'Create', group.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, activity))
              .catch((err) => fastify.log.error(err, 'Wiki page federation failed'));
          }
        }
      }

      // Notify all online members so wiki panels update live.
      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: request.params.serverId, action: 'created', slug: created.slug },
      });

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'wiki',
        action: 'wiki.create',
        summary: `Created wiki page "${trimmedTitle}"`,
        details: { pageId: created.id, slug },
      });

      return reply.status(201).send({ page: await toWikiPageView(db, created) });
    },
  );

  // Update a page
  fastify.put<{ Params: { serverId: string; slug: string }; Body: UpdateWikiPageInput }>(
    '/servers/:serverId/wiki/pages/:slug',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.serverId, request.params.serverId),
            eq(wikiPages.slug, request.params.slug),
          ),
        )
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      // AUDIT BUG FIX: editing previously had no role check at all —
      // any server member could overwrite any page. Now gated on
      // creator-override OR MANAGE_WIKI (consistent with delete).
      const isCreator = page.createdById === request.actor.id;
      const canEdit =
        isCreator ||
        (await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.MANAGE_WIKI,
        ));
      if (!canEdit) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const body = request.body ?? {};
      const nextTitle = body.title !== undefined ? body.title.trim() : page.title;
      const nextContent = body.content !== undefined ? body.content : page.content;
      const nextTags = body.tags !== undefined ? normalizeTags(body.tags) : page.tags;
      if (!nextTitle) return reply.status(400).send({ error: 'title cannot be empty' });

      // Determine next revision number
      const [{ max }] = await db
        .select({ max: sql<number>`COALESCE(MAX(${wikiPageRevisions.revisionNumber}), 0)` })
        .from(wikiPageRevisions)
        .where(eq(wikiPageRevisions.pageId, page.id));
      const nextRevision = Number(max) + 1;

      const [updated] = await db
        .update(wikiPages)
        .set({
          title: nextTitle,
          content: nextContent,
          tags: nextTags,
          contentSearch: buildSearchVector(nextTitle, nextContent),
          ...(body.parentId !== undefined ? { parentId: body.parentId ?? null } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          lastEditedById: request.actor.id,
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, page.id))
        .returning();

      await db.insert(wikiPageRevisions).values({
        pageId: page.id,
        revisionNumber: nextRevision,
        title: nextTitle,
        content: nextContent,
        editedById: request.actor.id,
        summary: body.summary?.trim() || null,
      });

      await syncPageOutboundLinks(db, updated.serverId, updated.id, updated.content);

      // Federation: deliver Update(Article).
      if (request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
        if (group) {
          const config = fastify.config;
          const protocol = config.secureCookies ? 'https' : 'http';
          const article = {
            type: 'Article',
            id: updated.uri ?? `${protocol}://${config.domain}/servers/${request.params.serverId}/wiki/${updated.slug}`,
            name: updated.title,
            content: updated.content,
            slug: updated.slug,
            tags: updated.tags,
            parentId: updated.parentId,
            position: updated.position,
            attributedTo: request.actor.uri,
            context: group.uri,
          };
          const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const activity = serializeActivity(activityUri, 'Update', request.actor.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, activity, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Wiki page update remote federation failed'));
          } else {
            const activity = serializeActivity(activityUri, 'Update', group.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, activity))
              .catch((err) => fastify.log.error(err, 'Wiki page update federation failed'));
          }
        }
      }

      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: request.params.serverId, action: 'updated', slug: updated.slug },
      });

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'wiki',
        action: 'wiki.update',
        summary: `Updated wiki page "${nextTitle}"`,
        details: { pageId: page.id, slug: request.params.slug },
      });

      return { page: await toWikiPageView(db, updated) };
    },
  );

  // Backlinks for a page — pages and messages that reference it
  fastify.get<{ Params: { serverId: string; slug: string } }>(
    '/servers/:serverId/wiki/pages/:slug/backlinks',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await isManualServer(request.params.serverId)) &&
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.serverId, request.params.serverId),
            eq(wikiPages.slug, request.params.slug),
          ),
        )
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const linkRows = await db
        .select()
        .from(wikiPageLinks)
        .where(eq(wikiPageLinks.targetPageId, page.id))
        .orderBy(desc(wikiPageLinks.createdAt));

      // Separate page and message sources; batch-load both.
      const sourcePageIds = Array.from(
        new Set(linkRows.filter((l) => l.sourcePageId).map((l) => l.sourcePageId!)),
      );
      const sourceMessageIds = Array.from(
        new Set(linkRows.filter((l) => l.sourceMessageId).map((l) => l.sourceMessageId!)),
      );

      const sourcePageRows = sourcePageIds.length
        ? await db.select().from(wikiPages).where(inArray(wikiPages.id, sourcePageIds))
        : [];
      const sourceMessageRows = sourceMessageIds.length
        ? await db.select().from(objects).where(inArray(objects.id, sourceMessageIds))
        : [];

      // Page editors for source summaries
      const editorIds = Array.from(new Set(sourcePageRows.map((p) => p.lastEditedById)));
      const editors = editorIds.length
        ? await db.select().from(actors).where(inArray(actors.id, editorIds))
        : [];
      const editorMap = new Map(editors.map((e) => [e.id, e]));

      // Message authors + channels for message summaries
      const authorIds = Array.from(
        new Set(sourceMessageRows.map((m) => m.attributedTo).filter((x): x is string => !!x)),
      );
      const authors = authorIds.length
        ? await db.select().from(actors).where(inArray(actors.id, authorIds))
        : [];
      const authorMap = new Map(authors.map((a) => [a.id, a]));

      const channelIds = Array.from(
        new Set(sourceMessageRows.map((m) => m.context).filter((x): x is string => !!x)),
      );
      const channelRows = channelIds.length
        ? await db.select().from(objects).where(inArray(objects.id, channelIds))
        : [];
      const channelMap = new Map(channelRows.map((c) => [c.id, c]));

      const pageMap = new Map(sourcePageRows.map((p) => [p.id, p]));
      const messageMap = new Map(sourceMessageRows.map((m) => [m.id, m]));

      const backlinks: WikiBacklinkView[] = [];
      for (const row of linkRows) {
        if (row.sourcePageId) {
          const src = pageMap.get(row.sourcePageId);
          if (!src) continue;
          backlinks.push({
            sourceType: 'page',
            page: toWikiPageSummary(src, editorMap.get(src.lastEditedById)),
            createdAt: row.createdAt.toISOString(),
          });
        } else if (row.sourceMessageId) {
          const msg = messageMap.get(row.sourceMessageId);
          if (!msg || msg.type !== 'Note') continue;
          const author = msg.attributedTo ? authorMap.get(msg.attributedTo) : null;
          const channel = msg.context ? channelMap.get(msg.context) : null;
          const channelProps = channel?.properties as Record<string, unknown> | null;
          const channelName = (channelProps?.name as string | undefined) ?? null;
          backlinks.push({
            sourceType: 'message',
            message: {
              id: msg.id,
              channelId: msg.context ?? '',
              channelName,
              author: author
                ? toAuthorView(author)
                : { id: msg.attributedTo ?? '', preferredUsername: 'unknown', displayName: null, avatarUrl: null },
              content: msg.content ?? '',
              createdAt: msg.published.toISOString(),
            },
            createdAt: row.createdAt.toISOString(),
          });
        }
      }

      return { backlinks };
    },
  );

  // Delete a page — creator can always delete own; MANAGE_WIKI
  // required to delete anyone else's.
  fastify.delete<{ Params: { serverId: string; slug: string } }>(
    '/servers/:serverId/wiki/pages/:slug',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.serverId, request.params.serverId),
            eq(wikiPages.slug, request.params.slug),
          ),
        )
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const isCreator = page.createdById === request.actor.id;
      const canDelete =
        isCreator ||
        (await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.MANAGE_WIKI,
        ));
      if (!canDelete) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      await db.delete(wikiPages).where(eq(wikiPages.id, page.id));
      if (page.chatId) {
        await db.delete(objects).where(eq(objects.id, page.chatId));
      }

      // Federation: deliver Delete(Article).
      if (request.actor.local && page.uri) {
        const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
        if (group) {
          const config = fastify.config;
          const protocol = config.secureCookies ? 'https' : 'http';
          const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const activity = serializeActivity(activityUri, 'Delete', request.actor.uri, page.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, activity, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Wiki page delete remote federation failed'));
          } else {
            const activity = serializeActivity(activityUri, 'Delete', group.uri, page.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, activity))
              .catch((err) => fastify.log.error(err, 'Wiki page delete federation failed'));
          }
        }
      }

      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: request.params.serverId, action: 'deleted', slug: page.slug },
      });

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'wiki',
        action: 'wiki.delete',
        summary: `Deleted wiki page "${page.slug}"`,
        details: { slug: page.slug },
      });

      return { ok: true };
    },
  );

  // Get per-server wiki settings (currently just the home slug).
  // Any VIEW_WIKI holder can read; MANAGE_WIKI required to write.
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/wiki/settings',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await isManualServer(request.params.serverId)) &&
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.params.serverId))
        .limit(1);
      const props = (server?.properties as Record<string, unknown> | null) ?? null;
      const rawHome = props && typeof props.wikiHomeSlug === 'string' ? (props.wikiHomeSlug as string) : null;

      // Validate that the stored home slug still points at a live page.
      // If not, surface null — the client will fall back to recency order.
      let homeSlug: string | null = null;
      if (rawHome) {
        const [home] = await db
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(and(eq(wikiPages.serverId, request.params.serverId), eq(wikiPages.slug, rawHome)))
          .limit(1);
        if (home) homeSlug = rawHome;
      }

      const settings: WikiSettingsView = { homeSlug };
      return { settings };
    },
  );

  fastify.put<{ Params: { serverId: string }; Body: UpdateWikiSettingsInput }>(
    '/servers/:serverId/wiki/settings',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.MANAGE_WIKI,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const body = request.body ?? {};

      // Load the current server properties so we can merge rather than
      // overwrite (other keys might live here).
      const [server] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, request.params.serverId))
        .limit(1);
      if (!server) return reply.status(404).send({ error: 'Server not found' });

      const currentProps = (server.properties as Record<string, unknown> | null) ?? {};
      const nextProps: Record<string, unknown> = { ...currentProps };

      if (body.homeSlug !== undefined) {
        if (body.homeSlug === null) {
          delete nextProps.wikiHomeSlug;
        } else {
          // Validate the slug exists in this server's wiki.
          const [home] = await db
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.serverId, request.params.serverId),
                eq(wikiPages.slug, body.homeSlug),
              ),
            )
            .limit(1);
          if (!home) return reply.status(404).send({ error: 'Home page slug does not exist' });
          nextProps.wikiHomeSlug = body.homeSlug;
        }
      }

      await db
        .update(actors)
        .set({ properties: nextProps })
        .where(eq(actors.id, request.params.serverId));

      const homeSlug = (nextProps.wikiHomeSlug as string | undefined) ?? null;

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'wiki',
        action: 'wiki.settings',
        summary: `Updated wiki settings`,
        details: { homeSlug },
      });

      const settings: WikiSettingsView = { homeSlug };
      return { settings };
    },
  );

  // List revisions for a page.
  fastify.get<{ Params: { serverId: string; slug: string } }>(
    '/servers/:serverId/wiki/pages/:slug/revisions',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (!(await isManualServer(request.params.serverId)) && !(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.VIEW_WIKI))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.serverId, request.params.serverId), eq(wikiPages.slug, request.params.slug)))
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const rows = await db
        .select({ rev: wikiPageRevisions, editor: actors })
        .from(wikiPageRevisions)
        .innerJoin(actors, eq(wikiPageRevisions.editedById, actors.id))
        .where(eq(wikiPageRevisions.pageId, page.id))
        .orderBy(desc(wikiPageRevisions.revisionNumber));

      return {
        revisions: rows.map((r) => ({
          id: r.rev.id,
          pageId: r.rev.pageId,
          revisionNumber: r.rev.revisionNumber,
          title: r.rev.title,
          editedBy: toAuthorView(r.editor),
          editedAt: r.rev.editedAt.toISOString(),
          summary: r.rev.summary,
        })),
      };
    },
  );

  // Get a single revision's content.
  fastify.get<{ Params: { serverId: string; slug: string; revisionNumber: string } }>(
    '/servers/:serverId/wiki/pages/:slug/revisions/:revisionNumber',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      if (!(await isManualServer(request.params.serverId)) && !(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.VIEW_WIKI))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.serverId, request.params.serverId), eq(wikiPages.slug, request.params.slug)))
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const revNum = parseInt(request.params.revisionNumber, 10);
      const [rev] = await db
        .select({ rev: wikiPageRevisions, editor: actors })
        .from(wikiPageRevisions)
        .innerJoin(actors, eq(wikiPageRevisions.editedById, actors.id))
        .where(and(eq(wikiPageRevisions.pageId, page.id), eq(wikiPageRevisions.revisionNumber, revNum)))
        .limit(1);
      if (!rev) return reply.status(404).send({ error: 'Revision not found' });

      return {
        revision: {
          id: rev.rev.id,
          pageId: rev.rev.pageId,
          revisionNumber: rev.rev.revisionNumber,
          title: rev.rev.title,
          content: rev.rev.content,
          editedBy: toAuthorView(rev.editor),
          editedAt: rev.rev.editedAt.toISOString(),
          summary: rev.rev.summary,
        },
      };
    },
  );

  // Restore a page to a previous revision. Creates a new revision
  // with the old content, preserving full history.
  fastify.post<{ Params: { serverId: string; slug: string; revisionNumber: string } }>(
    '/servers/:serverId/wiki/pages/:slug/restore/:revisionNumber',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.serverId, request.params.serverId), eq(wikiPages.slug, request.params.slug)))
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const isCreator = page.createdById === request.actor.id;
      const canEdit = isCreator || (await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.MANAGE_WIKI));
      if (!canEdit) return reply.status(403).send({ error: 'Insufficient permissions' });

      const revNum = parseInt(request.params.revisionNumber, 10);
      const [targetRev] = await db
        .select()
        .from(wikiPageRevisions)
        .where(and(eq(wikiPageRevisions.pageId, page.id), eq(wikiPageRevisions.revisionNumber, revNum)))
        .limit(1);
      if (!targetRev) return reply.status(404).send({ error: 'Revision not found' });

      // Determine next revision number
      const [{ max }] = await db
        .select({ max: sql<number>`COALESCE(MAX(${wikiPageRevisions.revisionNumber}), 0)` })
        .from(wikiPageRevisions)
        .where(eq(wikiPageRevisions.pageId, page.id));
      const nextRevision = Number(max) + 1;

      const [updated] = await db
        .update(wikiPages)
        .set({
          title: targetRev.title,
          content: targetRev.content,
          contentSearch: buildSearchVector(targetRev.title, targetRev.content),
          lastEditedById: request.actor.id,
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, page.id))
        .returning();

      await db.insert(wikiPageRevisions).values({
        pageId: page.id,
        revisionNumber: nextRevision,
        title: targetRev.title,
        content: targetRev.content,
        editedById: request.actor.id,
        summary: `Restored from revision ${revNum}`,
      });

      fastify.broadcastToAllSubscribers({
        type: 'wiki:page-changed',
        payload: { serverId: request.params.serverId, action: 'updated', slug: page.slug },
      });

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'wiki',
        action: 'wiki.restore',
        summary: `Restored wiki page to revision #${revNum}`,
        details: { pageId: page.id, slug: page.slug, revisionNumber: revNum },
      });

      return { page: await toWikiPageView(db, updated) };
    },
  );

  // Get the manual server ID. Used by the client to open the
  // manual wiki panel and resolve [[man:slug]] embeds.
  fastify.get('/manual/id', async (_request, reply) => {
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const manualUri = `${protocol}://${config.domain}/system/manual`;
    const [manual] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.uri, manualUri))
      .limit(1);
    if (!manual) return reply.status(404).send({ error: 'Manual not found' });
    return { serverId: manual.id };
  });

  // Manual page lookup by slug for [[man:slug]] embeds.
  fastify.get<{ Params: { slug: string } }>(
    '/manual/by-slug/:slug',
    async (request, reply) => {
      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';
      const manualUri = `${protocol}://${config.domain}/system/manual`;
      const [manual] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.uri, manualUri))
        .limit(1);
      if (!manual) return reply.status(404).send({ error: 'Manual not found' });

      const [page] = await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.serverId, manual.id), eq(wikiPages.slug, request.params.slug)))
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        content: page.content.slice(0, 500),
        serverId: manual.id,
        serverName: 'Babelr Manual',
      };
    },
  );

  // Wiki page embed lookup by slug. Used by cross-tower embeds
  // ([[server@tower:wiki:slug]]) and the local embed proxy.
  // Returns a compact view suitable for inline rendering.
  fastify.get<{ Params: { slug: string } }>(
    '/wiki/by-slug/:slug',
    async (request, reply) => {
      const { slug } = request.params;
      if (!slug) return reply.status(400).send({ error: 'slug is required' });

      // Find the page across all servers (for cross-tower resolution,
      // the server context comes from the request's tower, not from
      // a specific server parameter).
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(eq(wikiPages.slug, slug))
        .limit(1);
      if (!page) return reply.status(404).send({ error: 'Page not found' });

      const [server] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, page.serverId))
        .limit(1);

      return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        content: page.content.slice(0, 500),
        serverId: page.serverId,
        serverName: server?.displayName ?? server?.preferredUsername ?? null,
      };
    },
  );
}
