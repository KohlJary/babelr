// SPDX-License-Identifier: MIT
import { pgTable, uuid, varchar, timestamp, integer } from 'drizzle-orm/pg-core';
import { guestCards } from './guest-cards.ts';
import { actors } from './actors.ts';

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  serverId: uuid('server_id')
    .notNull()
    .references(() => actors.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => actors.id),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** The guest card this invite was made from (welcome.ts), if any. */
  guestCardId: uuid('guest_card_id').references(() => guestCards.id, { onDelete: 'set null' }),
});
