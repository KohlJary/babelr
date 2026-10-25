// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * API tokens for agent and service actors. The secret is shown once at
 * creation; only its sha256 is stored. A token is `bt_<id>_<secret>`,
 * so the hook can look the row up by id and compare hashes in
 * constant time.
 */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    /** The sponsor (or admin) who minted it. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id),
    name: varchar('name', { length: 64 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => actors.id),
  },
  (table) => [index('agent_tokens_actor_idx').on(table.actorId)],
);
