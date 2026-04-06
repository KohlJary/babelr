// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, text, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

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
    published: timestamp('published', { withTimezone: true }).notNull().defaultNow(),
    updated: timestamp('updated', { withTimezone: true }),
  },
  (table) => [
    index('objects_context_published_idx').on(table.context, table.published),
    index('objects_attributed_to_published_idx').on(table.attributedTo, table.published),
  ],
);
