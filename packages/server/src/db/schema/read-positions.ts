// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

export const readPositions = pgTable(
  'read_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').notNull().references(() => actors.id),
    channelId: uuid('channel_id').notNull().references(() => objects.id),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('read_positions_actor_channel_idx')
      .on(table.actorId, table.channelId),
  ],
);
