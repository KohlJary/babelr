// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

/**
 * Calendar events. Owned by either a user (Person actor) or a server
 * (Group actor). Every event auto-creates an associated OrderedCollection
 * row in `objects` to serve as the event's chat — that collection's id
 * is stored in `eventChatId` and reused by the existing channel message
 * helpers, so the event chat inherits the full message pipeline
 * (reactions, threads, attachments, translation) without special cases.
 *
 * Recurrence is stored as an RFC 5545 RRULE string. Expansion into
 * concrete instances happens at query time via rrule.js — we do not
 * materialize individual occurrences.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uri: varchar('uri', { length: 512 }).notNull().unique(),

    // 'user' or 'server'
    ownerType: varchar('owner_type', { length: 16 }).notNull(),
    ownerId: uuid('owner_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by_id').notNull().references(() => actors.id),

    title: varchar('title', { length: 256 }).notNull(),
    description: text('description'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    location: text('location'),

    // RFC 5545 recurrence rule string, null for one-off events
    rrule: text('rrule'),

    // Server events only — optional channel the event is anchored to
    channelId: uuid('channel_id').references(() => objects.id, { onDelete: 'set null' }),

    // The OrderedCollection that acts as this event's chat
    eventChatId: uuid('event_chat_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_owner_idx').on(table.ownerType, table.ownerId),
    index('events_start_at_idx').on(table.startAt),
    index('events_channel_idx').on(table.channelId),
  ],
);

/**
 * RSVP rows. One per (event, actor) pair.
 */
export const eventAttendees = pgTable(
  'event_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('event_attendees_event_actor_idx').on(table.eventId, table.actorId),
    index('event_attendees_actor_idx').on(table.actorId),
  ],
);
