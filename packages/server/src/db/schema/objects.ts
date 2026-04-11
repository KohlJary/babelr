// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, text, varchar, timestamp, jsonb, index, uniqueIndex, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { actors } from './actors.ts';

// Custom type for tsvector
const tsvector = customType<{ data: string; notNull: true; default: true }>({
  dataType() {
    return 'tsvector';
  },
});

export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uri: text('uri').notNull().unique(),
    type: varchar('type', { length: 64 }).notNull(),
    attributedTo: uuid('attributed_to').references(() => actors.id),
    content: text('content'),
    contentMap: jsonb('content_map'),
    mediaType: varchar('media_type', { length: 64 }).default('text/plain'),
    source: jsonb('source'),
    inReplyTo: uuid('in_reply_to'),
    context: uuid('context'),
    to: jsonb('to').default([]),
    cc: jsonb('cc').default([]),
    belongsTo: uuid('belongs_to').references(() => actors.id),
    properties: jsonb('properties').default({}),
    /**
     * Short, copy-paste-friendly identifier for the message. Generated
     * at create time for every Note-typed row; NULL for OrderedCollection
     * (channels) and other non-message object types. Enables
     * `[[msg:slug]]` references from wiki pages and other messages,
     * which render as embedded previews with click-to-navigate.
     * Globally unique across the server (enforced by partial index).
     */
    slug: varchar('slug', { length: 16 }),
    published: timestamp('published', { withTimezone: true }).notNull().defaultNow(),
    updated: timestamp('updated', { withTimezone: true }),
    contentSearch: tsvector('content_search'),
  },
  (table) => [
    index('objects_context_published_idx').on(table.context, table.published),
    index('objects_attributed_to_published_idx').on(table.attributedTo, table.published),
    // Partial unique index — only enforced for rows with a slug.
    // Channels and other non-message rows have NULL slug and are
    // unaffected. The WHERE predicate makes this partial.
    uniqueIndex('objects_slug_idx')
      .on(table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
  ],
);
