// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex, integer, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { objects } from './objects.ts';
import { actors } from './actors.ts';

const tsvector = customType<{ data: string; notNull: true; default: true }>({
  dataType() {
    return 'tsvector';
  },
});

// text[] column type — drizzle's built-in array helpers still route
// through jsonb or text in some codepaths, so we declare the raw
// Postgres type directly to get a real array column with GIN-indexable
// semantics for the tag filter.
const textArray = customType<{ data: string[]; driverData: string[]; notNull: true; default: true }>({
  dataType() {
    return 'text[]';
  },
});

/**
 * Server wiki pages. Long-form knowledge that persists outside the chat
 * stream — unlike messages, pages are editable in place and don't scroll
 * away. Scoped per-server; slug is unique within a server.
 *
 * Content is plain markdown. Every update writes a row to
 * `wiki_page_revisions` so history is fully reconstructible (UI for that
 * is deferred to a later PR).
 *
 * Federation as ActivityPub `Article` is deferred to a follow-up PR;
 * this table intentionally does not yet carry a federated `uri` column
 * to keep the first landing minimal.
 */
export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Federation identity URI — globally unique across instances. */
    uri: varchar('uri', { length: 512 }),
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 128 }).notNull(),
    title: varchar('title', { length: 256 }).notNull(),
    content: text('content').notNull().default(''),
    tags: textArray('tags').notNull().default(sql`ARRAY[]::text[]`),
    /** Parent page for nesting. NULL = root-level page. */
    parentId: uuid('parent_id'),
    /** Sort order within siblings. Lower values sort first. */
    position: integer('position').notNull().default(0),
    /** OrderedCollection for the page's comment thread. Same pattern as event chat and file comments. */
    chatId: uuid('chat_id').references(() => objects.id, { onDelete: 'cascade' }),
    /** Full-text search vector over title + content. Populated application-side on create/update. */
    contentSearch: tsvector('content_search'),
    createdById: uuid('created_by_id').notNull().references(() => actors.id),
    lastEditedById: uuid('last_edited_by_id').notNull().references(() => actors.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wiki_pages_server_slug_idx').on(table.serverId, table.slug),
    index('wiki_pages_server_idx').on(table.serverId),
    index('wiki_pages_parent_idx').on(table.parentId),
    index('wiki_pages_updated_idx').on(table.updatedAt),
    // GIN index for tag membership queries (tags @> ARRAY['...'])
    index('wiki_pages_tags_gin_idx').using('gin', table.tags),
    // GIN index for full-text search across title + content
    index('wiki_pages_content_search_idx').using('gin', table.contentSearch),
  ],
);

/**
 * Revision history for wiki pages. One row per edit (including the
 * initial create). `revisionNumber` starts at 1 and monotonically
 * increases per page.
 */
export const wikiPageRevisions = pgTable(
  'wiki_page_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    title: varchar('title', { length: 256 }).notNull(),
    content: text('content').notNull(),
    editedById: uuid('edited_by_id').notNull().references(() => actors.id),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
    summary: text('summary'),
  },
  (table) => [
    uniqueIndex('wiki_page_revisions_page_num_idx').on(table.pageId, table.revisionNumber),
    index('wiki_page_revisions_page_idx').on(table.pageId),
  ],
);

/**
 * Bidirectional link graph between wiki pages and other content. A row
 * represents "source references target". Populated whenever a wiki page
 * or a message is written, by parsing `[[slug]]` refs out of the markdown.
 *
 * sourceType / targetType are 'page' or 'message'. For pages we reference
 * wikiPages.id; for messages we reference objects.id (messages live in
 * the objects table as ActivityPub Notes).
 *
 * We intentionally store *unresolved* slug refs too — if a page is
 * deleted the link rows are cascaded, but if a ref points to a
 * not-yet-created page the row is omitted (we only insert resolvable
 * refs at the moment of parse). A future follow-up could persist
 * unresolved refs for later resolution.
 */
export const wikiPageLinks = pgTable(
  'wiki_page_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    sourceType: varchar('source_type', { length: 16 }).notNull(),
    // Nullable per-source FK columns so we get proper cascade behavior
    // without a polymorphic FK. Exactly one is populated based on sourceType.
    sourcePageId: uuid('source_page_id').references(() => wikiPages.id, { onDelete: 'cascade' }),
    sourceMessageId: uuid('source_message_id').references(() => objects.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 16 }).notNull(),
    targetPageId: uuid('target_page_id').references(() => wikiPages.id, { onDelete: 'cascade' }),
    targetMessageId: uuid('target_message_id').references(() => objects.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wiki_page_links_target_page_idx').on(table.targetPageId),
    index('wiki_page_links_target_message_idx').on(table.targetMessageId),
    index('wiki_page_links_source_page_idx').on(table.sourcePageId),
    index('wiki_page_links_source_message_idx').on(table.sourceMessageId),
    index('wiki_page_links_server_idx').on(table.serverId),
  ],
);
