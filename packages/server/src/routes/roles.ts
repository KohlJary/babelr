// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import '../types.ts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  type CreateServerRoleInput,
  type ServerRoleView,
  type UpdateServerRoleInput,
} from '@babelr/shared';
import { actors } from '../db/schema/actors.ts';
import { serverRoles, serverRoleAssignments } from '../db/schema/roles.ts';
import { hasPermission, ensureManageRolesSurvives, LockoutError } from '../permissions.ts';

/**
 * Per-server role management. Every route in this module is gated
 * on `MANAGE_ROLES`, and every mutation wraps its write in a
 * transaction that calls `ensureManageRolesSurvives` so the
 * lockout invariant is enforced at the last possible moment.
 *
 * System roles (`isSystem = true`, currently just @everyone):
 *   - Cannot be renamed.
 *   - Cannot be deleted.
 *   - CAN have their permissions edited — otherwise the @everyone
 *     role is useless as a default-permission control.
 *
 * Role hierarchy enforcement (can-only-edit-below-you) is
 * intentionally not in this PR. It lands with the
 * `granular-permissions-role-hierarchy` follow-up.
 */

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

function toRoleView(row: typeof serverRoles.$inferSelect): ServerRoleView {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    color: row.color,
    position: row.position,
    permissions: row.permissions ?? [],
    isDefault: row.isDefault,
    isSystem: row.isSystem,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate a user-supplied color string. Accepts `#rrggbb` or
 * `#rgb` (case-insensitive). Returns the normalized lowercase form
 * or throws a plain Error on invalid input — the caller converts
 * that to a 400.
 */
function normalizeColor(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') {
    throw new Error('color must be a string');
  }
  const trimmed = input.trim().toLowerCase();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(trimmed)) {
    throw new Error('color must be a hex string like #4b6cb7');
  }
  return trimmed;
}

/**
 * Validate and dedupe a user-supplied permissions array. Unknown
 * permission strings are dropped silently — this is the same
 * forgiving policy the shared PERMISSIONS enum applies when the
 * server learns a new permission flag that an older client doesn't
 * yet know about, so neither side falls over.
 */
function normalizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (!VALID_PERMISSIONS.has(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

async function loadServer(db: ReturnType<typeof import('../db/index.ts').createDb>, serverId: string) {
  const [server] = await db
    .select()
    .from(actors)
    .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
    .limit(1);
  return server ?? null;
}

export default async function roleRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // List all roles on a server. Members can read (they need this to
  // see who's in which role and for the role management UI). Write
  // gates are enforced per-mutation.
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/roles',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      // Any server member can view the role list. We reuse VIEW_CHANNELS
      // as the minimum-membership check since @everyone has it by
      // default and non-members don't.
      if (
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.VIEW_CHANNELS,
        ))
      ) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      const rows = await db
        .select()
        .from(serverRoles)
        .where(eq(serverRoles.serverId, request.params.serverId))
        .orderBy(asc(serverRoles.position), asc(serverRoles.name));

      return { roles: rows.map(toRoleView) };
    },
  );

  // Create a new role.
  fastify.post<{ Params: { serverId: string }; Body: CreateServerRoleInput }>(
    '/servers/:serverId/roles',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId } = request.params;
      if (
        !(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const server = await loadServer(db, serverId);
      if (!server) return reply.status(404).send({ error: 'Server not found' });

      const body = request.body ?? {};
      const name = (body.name ?? '').trim();
      if (!name) return reply.status(400).send({ error: 'Role name is required' });
      if (name.length > 64) return reply.status(400).send({ error: 'Role name too long (max 64)' });

      let color: string | null;
      try {
        color = normalizeColor(body.color ?? null);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      const permissions = normalizePermissions(body.permissions);

      // Reject duplicate name (unique index would throw with an ugly
      // pg error; catch it early).
      const [existing] = await db
        .select({ id: serverRoles.id })
        .from(serverRoles)
        .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, name)))
        .limit(1);
      if (existing) {
        return reply.status(409).send({ error: 'A role with that name already exists' });
      }

      // New roles go at the top of the non-system positions. The
      // hierarchy follow-up will add explicit reordering; for now
      // max+1 is a reasonable default.
      const [max] = await db
        .select({ position: serverRoles.position })
        .from(serverRoles)
        .where(eq(serverRoles.serverId, serverId))
        .orderBy(asc(serverRoles.position))
        .limit(1);
      const nextPosition = (max?.position ?? 0) + 1;

      const [created] = await db
        .insert(serverRoles)
        .values({
          serverId,
          name,
          color,
          position: nextPosition,
          permissions,
          isDefault: false,
          isSystem: false,
        })
        .returning();

      return reply.status(201).send({ role: toRoleView(created) });
    },
  );

  // Edit a role (name, color, permissions). System roles can have
  // permissions edited but not name/delete.
  fastify.put<{ Params: { serverId: string; roleId: string }; Body: UpdateServerRoleInput }>(
    '/servers/:serverId/roles/:roleId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId, roleId } = request.params;
      if (
        !(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const [role] = await db
        .select()
        .from(serverRoles)
        .where(and(eq(serverRoles.id, roleId), eq(serverRoles.serverId, serverId)))
        .limit(1);
      if (!role) return reply.status(404).send({ error: 'Role not found' });

      const body = request.body ?? {};

      // Build the update set, field by field.
      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (body.name !== undefined) {
        if (role.isSystem) {
          return reply.status(400).send({ error: 'Cannot rename a system role' });
        }
        const name = body.name.trim();
        if (!name) return reply.status(400).send({ error: 'Role name cannot be empty' });
        if (name.length > 64) return reply.status(400).send({ error: 'Role name too long (max 64)' });
        if (name !== role.name) {
          const [existing] = await db
            .select({ id: serverRoles.id })
            .from(serverRoles)
            .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, name)))
            .limit(1);
          if (existing) {
            return reply.status(409).send({ error: 'A role with that name already exists' });
          }
        }
        updates.name = name;
      }

      if (body.color !== undefined) {
        try {
          updates.color = normalizeColor(body.color);
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
      }

      if (body.permissions !== undefined) {
        updates.permissions = normalizePermissions(body.permissions);
      }

      try {
        const updated = await db.transaction(async (tx) => {
          const [result] = await tx
            .update(serverRoles)
            .set(updates)
            .where(eq(serverRoles.id, roleId))
            .returning();
          // If the edit removed MANAGE_ROLES from a role that some
          // members depend on for their manage-roles permission, the
          // invariant will throw and the transaction rolls back.
          await ensureManageRolesSurvives(tx, serverId);
          return result;
        });
        return { role: toRoleView(updated) };
      } catch (err) {
        if (err instanceof LockoutError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Delete a role. System roles and the default role cannot be
  // deleted. Role assignments cascade via FK. Lockout invariant is
  // checked after the delete so a "last admin role" delete fails
  // cleanly.
  fastify.delete<{ Params: { serverId: string; roleId: string } }>(
    '/servers/:serverId/roles/:roleId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId, roleId } = request.params;
      if (
        !(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const [role] = await db
        .select()
        .from(serverRoles)
        .where(and(eq(serverRoles.id, roleId), eq(serverRoles.serverId, serverId)))
        .limit(1);
      if (!role) return reply.status(404).send({ error: 'Role not found' });
      if (role.isSystem) {
        return reply.status(400).send({ error: 'Cannot delete a system role' });
      }
      if (role.isDefault) {
        return reply.status(400).send({ error: 'Cannot delete the default role' });
      }

      try {
        await db.transaction(async (tx) => {
          await tx.delete(serverRoles).where(eq(serverRoles.id, roleId));
          await ensureManageRolesSurvives(tx, serverId);
        });
      } catch (err) {
        if (err instanceof LockoutError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      return { ok: true };
    },
  );

  // Assign a role to a member.
  fastify.post<{ Params: { serverId: string; actorId: string; roleId: string } }>(
    '/servers/:serverId/members/:actorId/roles/:roleId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId, actorId, roleId } = request.params;
      if (
        !(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const [role] = await db
        .select()
        .from(serverRoles)
        .where(and(eq(serverRoles.id, roleId), eq(serverRoles.serverId, serverId)))
        .limit(1);
      if (!role) return reply.status(404).send({ error: 'Role not found' });
      if (role.isDefault) {
        return reply
          .status(400)
          .send({ error: 'The default role is implicit and cannot be assigned explicitly' });
      }

      // Upsert: ON CONFLICT DO NOTHING so reassigning is idempotent.
      await db
        .insert(serverRoleAssignments)
        .values({ serverId, actorId, roleId })
        .onConflictDoNothing();

      return { ok: true };
    },
  );

  // Unassign a role from a member.
  fastify.delete<{ Params: { serverId: string; actorId: string; roleId: string } }>(
    '/servers/:serverId/members/:actorId/roles/:roleId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId, actorId, roleId } = request.params;
      if (
        !(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      try {
        await db.transaction(async (tx) => {
          await tx
            .delete(serverRoleAssignments)
            .where(
              and(
                eq(serverRoleAssignments.serverId, serverId),
                eq(serverRoleAssignments.actorId, actorId),
                eq(serverRoleAssignments.roleId, roleId),
              ),
            );
          await ensureManageRolesSurvives(tx, serverId);
        });
      } catch (err) {
        if (err instanceof LockoutError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      return { ok: true };
    },
  );
}
