// SPDX-License-Identifier: Hippocratic-3.0
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { objects } from './objects.ts';

export const collectionItems = pgTable(
  'collection_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionUri: text('collection_uri').notNull(),
    collectionId: uuid('collection_id').references(() => objects.id),
    itemUri: text('item_uri').notNull(),
    itemId: uuid('item_id'),
    position: integer('position'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('collection_items_unique_idx').on(table.collectionUri, table.itemUri),
    index('collection_items_collection_position_idx').on(table.collectionUri, table.position),
  ],
);
