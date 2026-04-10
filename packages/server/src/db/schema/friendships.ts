// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * Each row represents one user's view of a relationship with another user.
 * A mutual friendship is two rows — one owned by each side (on their
 * respective home instances if federated).
 *
 * States:
 * - `pending_out` — owner sent a friend request, awaiting acceptance
 * - `pending_in`  — owner received a friend request, can accept/decline
 * - `accepted`    — mutual friendship
 */
export const friendships = pgTable(
  'friendships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerActorId: uuid('owner_actor_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    otherActorId: uuid('other_actor_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('friendships_owner_other_idx').on(table.ownerActorId, table.otherActorId),
    index('friendships_owner_idx').on(table.ownerActorId),
    index('friendships_state_idx').on(table.state),
  ],
);
