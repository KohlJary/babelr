// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull(),
    targetType: varchar('target_type', { length: 16 }).notNull(),
    muted: boolean('muted').notNull().default(false),
  },
  (table) => [
    uniqueIndex('notification_prefs_unique_idx').on(table.actorId, table.targetId),
  ],
);
