// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

export const reactions = pgTable(
  'reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id').notNull().references(() => objects.id),
    actorId: uuid('actor_id').notNull().references(() => actors.id),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('reactions_object_id_idx').on(table.objectId),
    index('reactions_actor_id_idx').on(table.actorId),
  ],
);
