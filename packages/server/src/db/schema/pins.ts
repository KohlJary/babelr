// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * Generic pin table. contextId is "where" the pin lives (channel,
 * wiki page, board), targetId is "what" is pinned (message, page,
 * work item). targetType helps the client render the right preview.
 * Currently used for channel messages; extensible to wiki/embeds.
 */
export const pins = pgTable(
  'pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id').notNull(),
    targetId: uuid('target_id').notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull().default('message'),
    pinnedBy: uuid('pinned_by')
      .notNull()
      .references(() => actors.id),
    pinnedAt: timestamp('pinned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('pins_context_target_idx').on(table.contextId, table.targetId),
  ],
);
