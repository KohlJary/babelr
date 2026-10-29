// SPDX-License-Identifier: MIT
import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

/**
 * DM consent (Babelr step 3d). Everyone can say no and everyone can
 * leave: these tables hold the "no"s and the leavings. The policy
 * itself is `actors.dm_policy`.
 */

/** `blocker` blocked `blocked`: no DMs, requests or mentions from them. */
export const actorBlocks = pgTable(
  'actor_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('actor_blocks_pair_idx').on(table.blockerId, table.blockedId),
    index('actor_blocks_blocked_idx').on(table.blockedId),
  ],
);

/** `owner` lets `allowed` open a DM whatever owner's policy says. */
export const dmAllowlist = pgTable(
  'dm_allowlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    allowedId: uuid('allowed_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    /** Who added the row: the owner, or a sponsor setting an agent's
     *  initial list at creation (recorded, and audited). */
    addedBy: uuid('added_by').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('dm_allowlist_pair_idx').on(table.ownerId, table.allowedId)],
);

/**
 * A stranger's first message to someone whose policy is `friends` or
 * `members_of_shared_servers`. One row per (from, to): a later request
 * after the cooldown reuses it.
 *   pending:  `to` hasn't answered; `from` may send one message
 *             (sent_count).
 *   accepted: an ordinary DM.
 *   declined: `to` left it; `from` can't ask again until cooldown_until.
 */
export const dmRequests = pgTable(
  'dm_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dmId: uuid('dm_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    fromId: uuid('from_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    toId: uuid('to_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 16 }).notNull().default('pending'),
    /** Messages the requester has sent while pending (limit: 1). */
    sentCount: integer('sent_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('dm_requests_pair_idx').on(table.fromId, table.toId),
    index('dm_requests_to_state_idx').on(table.toId, table.state),
    index('dm_requests_dm_idx').on(table.dmId),
  ],
);

/**
 * `actor` left `dm`. They no longer receive it, the others see "left",
 * and nobody else can put them back: only the leaver can reopen it.
 * `reason` is 'left', or 'declined' when they declined a request.
 */
export const dmDepartures = pgTable(
  'dm_departures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dmId: uuid('dm_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 16 }).notNull().default('left'),
    leftAt: timestamp('left_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('dm_departures_dm_actor_idx').on(table.dmId, table.actorId),
    index('dm_departures_actor_idx').on(table.actorId),
  ],
);
