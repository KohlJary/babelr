// SPDX-License-Identifier: MIT
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { invites } from './invites.ts';
import { guestCards } from './guest-cards.ts';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

/**
 * Welcoming newcomers (see welcome.ts). Opt-in, per member, per server:
 * a row here exists only because `actor` asked for it with its own
 * session or token. Nobody else can add one.
 */
export const serverWelcomers = pgTable(
  'server_welcomers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('server_welcomers_pair_idx').on(table.serverId, table.actorId)],
);

/**
 * One welcomer's welcome of one newcomer to one server. The unique
 * index is what makes the trigger idempotent: retries, a second join
 * and the catch-up sweep all collide on it.
 *   pending: the DM is open; the welcomer hasn't said hello yet.
 *   done:    the welcomer said hello (or marked it done).
 *   skipped: consent said no (a block, someone left, the newcomer's
 *            own policy) or the welcomer has no key; no DM was made.
 */
export const welcomes = pgTable(
  'welcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    newcomerId: uuid('newcomer_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    welcomerId: uuid('welcomer_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    dmId: uuid('dm_id').references(() => objects.id, { onDelete: 'set null' }),
    invitedById: uuid('invited_by_id').references(() => actors.id, { onDelete: 'set null' }),
    state: varchar('state', { length: 16 }).notNull().default('pending'),
    reason: varchar('reason', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('welcomes_triple_idx').on(table.serverId, table.newcomerId, table.welcomerId),
    index('welcomes_welcomer_state_idx').on(table.welcomerId, table.state),
  ],
);

/**
 * How a person arrived in a server through an invite: who invited them
 * and, for an invite made from a guest card, which card. One row per
 * (server, person), written when the invite brings them in.
 *   lookup_consent: null until the person answers (asked only when the
 *   card has seeds); true lets welcomers see and use the seeds; false
 *   withholds them. The person can change it later.
 */
export const inviteArrivals = pgTable(
  'invite_arrivals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    inviteId: uuid('invite_id').references(() => invites.id, { onDelete: 'set null' }),
    invitedById: uuid('invited_by_id').references(() => actors.id, { onDelete: 'set null' }),
    guestCardId: uuid('guest_card_id').references(() => guestCards.id, { onDelete: 'set null' }),
    /** A link the person added themselves on the consent screen. */
    addedLink: varchar('added_link', { length: 500 }),
    lookupConsent: boolean('lookup_consent'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invite_arrivals_pair_idx').on(table.serverId, table.actorId),
    index('invite_arrivals_actor_idx').on(table.actorId),
  ],
);
