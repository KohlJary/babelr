// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, text, varchar, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

export const deliveryQueue = pgTable(
  'delivery_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    activityJson: jsonb('activity_json').notNull(),
    recipientInboxUri: text('recipient_inbox_uri').notNull(),
    senderActorId: uuid('sender_actor_id')
      .notNull()
      .references(() => actors.id),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
  },
  (table) => [
    index('delivery_queue_pending_idx').on(table.status, table.nextAttemptAt),
  ],
);
