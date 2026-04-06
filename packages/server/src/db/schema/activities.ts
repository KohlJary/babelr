// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, text, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uri: text('uri').notNull().unique(),
    type: varchar('type', { length: 32 }).notNull(),
    actorId: uuid('actor_id').notNull().references(() => actors.id),
    objectUri: text('object_uri').notNull(),
    objectId: uuid('object_id').references(() => objects.id),
    targetUri: text('target_uri'),
    to: jsonb('to').default([]),
    cc: jsonb('cc').default([]),
    properties: jsonb('properties').default({}),
    published: timestamp('published', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activities_actor_id_published_idx').on(table.actorId, table.published),
    index('activities_object_id_idx').on(table.objectId),
  ],
);
