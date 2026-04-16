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
    properties: jsonb('properties').default({}),
    local: boolean('local').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('actors_preferred_username_local_idx')
      .on(table.preferredUsername)
      .where(sql`${table.local} = true`),
  ],
);
