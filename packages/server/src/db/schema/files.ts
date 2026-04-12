// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { actors } from './actors.ts';
import { objects } from './objects.ts';

/**
 * Per-server file library. Each file is a first-class entity with a
 * slug for `[[file:slug]]` embeds, a translatable description, and
 * optional folder-path-based hierarchy. The binary is stored via the
 * existing /uploads pipeline; this table holds metadata only.
 */
export const serverFiles = pgTable(
  'server_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id').notNull().references(() => actors.id),

    filename: varchar('filename', { length: 512 }).notNull(),
    contentType: varchar('content_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageUrl: text('storage_url').notNull(),

    /**
     * Short copy-paste slug for `[[file:slug]]` embeds. Same 10-char
     * Crockford-ish alphabet as messages and events. Globally unique
     * via partial unique index.
     */
    slug: varchar('slug', { length: 16 }),

    /** Human-readable title, defaults to filename if not set. */
    title: varchar('title', { length: 256 }),
    /** Translatable description — flows through the translation pipeline. */
    description: text('description'),
    /** Freeform tags for filtering. */
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Simple folder path for hierarchy, e.g. "docs/specs". Nullable = root. */
    folderPath: varchar('folder_path', { length: 512 }),

    /**
     * OrderedCollection that acts as this file's comment thread,
     * reusing the full message pipeline (reactions, threads,
     * translation, typing indicators) — same pattern as event chat.
     */
    chatId: uuid('chat_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('server_files_server_idx').on(table.serverId),
    index('server_files_folder_idx').on(table.serverId, table.folderPath),
    uniqueIndex('server_files_slug_idx')
      .on(table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
  ],
);

