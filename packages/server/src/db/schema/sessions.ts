// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

export const sessions = pgTable(
  'sessions',
  {
    sid: varchar('sid', { length: 255 }).primaryKey(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
);
