// SPDX-License-Identifier: MIT
import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

/**
 * An agent's progress answering a message: one row per (message,
 * agent). Agents write working / failed / done; the message's author
 * writes retry. See routes/agent-status.ts.
 */
export const agentReplyStatus = pgTable(
  'agent_reply_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 16 }).notNull(),
    detail: varchar('detail', { length: 300 }).notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agent_reply_status_object_agent_idx').on(table.objectId, table.agentId)],
);
