// SPDX-License-Identifier: Hippocratic-3.0
import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { actors } from './actors.ts';

/**
 * Per-server role definitions. Replaces the old
 * `collection_items.properties.role` enum string with a proper
 * row-per-role model that can carry a permissions array, a
 * hierarchy position, and metadata.
 *
 * Invariants:
 * - Exactly one row per server has `isDefault = true`. That's the
 *   implicit `@everyone` role applied to every server member. No
 *   row in `server_role_assignments` is needed — membership alone
 *   grants it.
 * - `isSystem = true` roles cannot be renamed or deleted. Currently
 *   just `@everyone`, but Moderator/Admin could be promoted to
 *   system in the future if we need to protect them.
 * - `position` is reserved for role hierarchy enforcement (can't
 *   edit a role above yours, can't kick someone whose highest role
 *   equals or exceeds yours). The initial PR stores it but does not
 *   enforce hierarchy — enforcement lands in the
 *   `granular-permissions-role-hierarchy` follow-up.
 *
 * Permissions are stored as a JSONB string array rather than a
 * bitfield. Trivially extensible when we add new flags, human-readable
 * in the DB for debugging, and set-membership lookups are O(N) over
 * a ~20-element array which is fine at chat scale.
 */
export const serverRoles = pgTable(
  'server_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    /** Hex color string like "#4b6cb7", null = no explicit color */
    color: varchar('color', { length: 16 }),
    /** Higher = more privileged. Used by the role-hierarchy follow-up. */
    position: integer('position').notNull().default(0),
    /** Flat array of permission strings from `@babelr/shared` PERMISSIONS */
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    /** True for the implicit @everyone role every server has exactly one of */
    isDefault: boolean('is_default').notNull().default(false),
    /** True for roles that cannot be renamed or deleted (currently @everyone only) */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('server_roles_server_name_idx').on(table.serverId, table.name),
    index('server_roles_server_idx').on(table.serverId),
    index('server_roles_position_idx').on(table.serverId, table.position),
  ],
);

/**
 * Role assignments. Many-to-many between server members and the
 * roles of that server. A member can hold any number of roles; their
 * effective permissions are the union across all assigned roles
 * plus the server's @everyone role (implicit, not stored here).
 *
 * Composite primary key on (serverId, actorId, roleId) so duplicate
 * inserts are idempotent and cleanup cascades cleanly when a role
 * or a member is removed.
 */
export const serverRoleAssignments = pgTable(
  'server_role_assignments',
  {
    serverId: uuid('server_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').notNull().references(() => actors.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => serverRoles.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.actorId, table.roleId] }),
    index('server_role_assignments_server_actor_idx').on(table.serverId, table.actorId),
    index('server_role_assignments_role_idx').on(table.roleId),
  ],
);
