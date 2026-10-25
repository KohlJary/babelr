// SPDX-License-Identifier: Hippocratic-3.0
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const actors = pgTable(
  'actors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uri: text('uri').notNull().unique(),
    type: varchar('type', { length: 32 }).notNull().default('Person'),
    preferredUsername: varchar('preferred_username', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 128 }),
    summary: text('summary'),
    email: varchar('email', { length: 256 }),
    passwordHash: text('password_hash'),
    privateKeyPem: text('private_key_pem'),
    inboxUri: text('inbox_uri').notNull(),
    outboxUri: text('outbox_uri').notNull(),
    followersUri: text('followers_uri'),
    followingUri: text('following_uri'),
    preferredLanguage: varchar('preferred_language', { length: 16 }).default('en'),
    emailVerified: boolean('email_verified').notNull().default(false),
    verificationToken: text('verification_token'),
    verificationTokenExpires: timestamp('verification_token_expires', { withTimezone: true }),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpRecoveryCodes: jsonb('totp_recovery_codes').default([]),
    properties: jsonb('properties').default({}),
    /**
     * Who this actor is: 'person' (a human with a password or SSO),
     * 'agent' (software acting as itself, AS2 type Person) or
     * 'service' (a bot anyone can message, AS2 type Service). Agents
     * and services authenticate only with API tokens and always have
     * a sponsor. Remote actors keep the default unless they arrive
     * as AS2 Service.
     */
    kind: varchar('kind', { length: 16 }).notNull().default('person'),
    /** The local person responsible for an agent or service. */
    sponsorId: uuid('sponsor_id').references((): AnyPgColumn => actors.id, {
      onDelete: 'restrict',
    }),
    /** Set by the kill switch: tokens revoked, posting blocked. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedBy: uuid('suspended_by').references((): AnyPgColumn => actors.id, {
      onDelete: 'set null',
    }),
    /**
     * Who may open a DM with this actor: 'anyone', 'friends',
     * 'members_of_shared_servers' or 'nobody' (plus dm_allowlist).
     * People default to 'anyone' (Babelr's behavior before 3d); agents
     * and services start at 'nobody' until their own config says
     * otherwise.
     */
    dmPolicy: varchar('dm_policy', { length: 32 }).notNull().default('anyone'),
    /** Who last set dm_policy: the actor itself, or the sponsor at
     *  creation. Null when it is still the default. */
    dmPolicySetBy: uuid('dm_policy_set_by').references((): AnyPgColumn => actors.id, {
      onDelete: 'set null',
    }),
    dmPolicySetAt: timestamp('dm_policy_set_at', { withTimezone: true }),
    local: boolean('local').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('actors_preferred_username_local_idx')
      .on(table.preferredUsername)
      .where(sql`${table.local} = true`),
    index('actors_sponsor_idx').on(table.sponsorId),
  ],
);
