// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

export const serverBans = pgTable(
  'server_bans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    bannedBy: uuid('banned_by')
      .notNull()
      .references(() => actors.id),
    reason: text('reason'),
    bannedAt: timestamp('banned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('server_bans_server_user_idx').on(table.serverId, table.userId),
  ],
);
