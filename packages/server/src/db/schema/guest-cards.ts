// SPDX-License-Identifier: MIT
import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * A guest card: an inviter's own record of someone they're bringing into
 * a server, made before the invite. "Make invite" on the card mints a
 * single-use invite tied to it (invites.guest_card_id).
 *
 * Visible to the inviter, the server's managers, and the server's
 * opted-in welcomers (so a daemon can prepare before the person
 * arrives). Never to other members, and never to the person themselves,
 * except the seeds, which they see verbatim on the consent screen.
 */
export const guestCards = pgTable(
  'guest_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    /** Their name, as the inviter knows them. */
    name: varchar('name', { length: 100 }).notNull(),
    /** The inviter's shorthand ("Mom"). */
    label: varchar('label', { length: 64 }),
    /** Links, handles, a one-line "who they are". */
    seeds: text('seeds'),
    /** A longer note to the house. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('guest_cards_server_idx').on(table.serverId, table.createdBy)],
);

/**
 * Facts about the person on a card, one per row, so a card can grow into
 * the house's shared people layer without a rewrite: who added each fact
 * and from where. Today only the inviter adds them (source 'inviter');
 * later sources: 'self', 'lookup:<url>', 'promoted:<daemon>'.
 * Seeds and the note stay separate fields on the card.
 */
export const guestCardFacts = pgTable(
  'guest_card_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => guestCards.id, { onDelete: 'cascade' }),
    /** What the fact is about: 'pronouns', 'occupation', 'relation', ... */
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    addedBy: uuid('added_by').references(() => actors.id, { onDelete: 'set null' }),
    source: varchar('source', { length: 200 }).notNull().default('inviter'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('guest_card_facts_card_idx').on(table.cardId)],
);
