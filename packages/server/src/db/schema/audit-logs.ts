// SPDX-License-Identifier: Hippocratic-3.0
import { pgTable, uuid, varchar, text, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * Server-scoped audit log. Every admin/moderation action writes a row
 * so server owners have a queryable history of who did what and when.
 *
 * Actions are categorized by domain (server, channel, role, wiki,
 * event, file, member) and include a free-form detail JSONB column
 * for action-specific metadata (e.g. old/new values, target user).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Server this action occurred in. */
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    /** Actor who performed the action. */
    actorId: uuid('actor_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    /** Action category — groups related actions for filtering. */
    category: varchar('category', { length: 32 }).notNull(),
    /** Specific action identifier, e.g. 'server.update', 'role.create'. */
    action: varchar('action', { length: 64 }).notNull(),
    /** Human-readable summary for the log viewer. */
    summary: text('summary').notNull(),
    /** Action-specific metadata: target IDs, old/new values, etc. */
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_server_idx').on(table.serverId),
    index('audit_logs_server_created_idx').on(table.serverId, table.createdAt),
    index('audit_logs_actor_idx').on(table.actorId),
    index('audit_logs_action_idx').on(table.action),
  ],
);
