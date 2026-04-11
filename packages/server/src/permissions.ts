// SPDX-License-Identifier: Hippocratic-3.0
import { and, eq, inArray } from 'drizzle-orm';
import type { Permission } from '@babelr/shared';
import { PERMISSIONS } from '@babelr/shared';
import { serverRoles, serverRoleAssignments } from './db/schema/roles.ts';
import { collectionItems } from './db/schema/collections.ts';
import { actors } from './db/schema/actors.ts';
import type { createDb } from './db/index.ts';

type Db = ReturnType<typeof createDb>;

/**
 * Compute the full set of permissions an actor has on a given server.
 * Union of:
 *
 * - The server's `@everyone` default role (applies to every member
 *   with no assignment row needed).
 * - Every role explicitly assigned to the actor via
 *   `server_role_assignments`.
 *
 * Returns an empty set if the actor is not a member of the server.
 * Non-members must not get any permissions — that's how wiki reads
 * and event visibility are gated.
 *
 * No owner-bypass codepath exists by design. The server creator is
 * assigned to the Admin role at creation time like any other user.
 * The lockout-protection invariant (see `ensureManageRolesSurvives`)
 * is what prevents accidental lockouts.
 */
export async function getEffectivePermissions(
  db: Db,
  serverId: string,
  actorId: string,
): Promise<Set<string>> {
  // Resolve the actor and server URIs we need for the membership check.
  const [actor] = await db
    .select({ uri: actors.uri })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!actor) return new Set();

  const [server] = await db
    .select({ followersUri: actors.followersUri })
    .from(actors)
    .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
    .limit(1);
  if (!server?.followersUri) return new Set();

  // Membership gate.
  const [membership] = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, server.followersUri),
        eq(collectionItems.itemUri, actor.uri),
      ),
    )
    .limit(1);
  if (!membership) return new Set();

  // Load the @everyone role (always applies to every member).
  const defaultRoles = await db
    .select({ permissions: serverRoles.permissions })
    .from(serverRoles)
    .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isDefault, true)));

  // Load every role explicitly assigned to this actor on this server.
  const assignedRoles = await db
    .select({ permissions: serverRoles.permissions })
    .from(serverRoles)
    .innerJoin(
      serverRoleAssignments,
      and(
        eq(serverRoleAssignments.roleId, serverRoles.id),
        eq(serverRoleAssignments.serverId, serverId),
        eq(serverRoleAssignments.actorId, actorId),
      ),
    );

  const effective = new Set<string>();
  for (const row of defaultRoles) {
    for (const p of row.permissions ?? []) effective.add(p);
  }
  for (const row of assignedRoles) {
    for (const p of row.permissions ?? []) effective.add(p);
  }
  return effective;
}

export async function hasPermission(
  db: Db,
  serverId: string,
  actorId: string,
  permission: Permission,
): Promise<boolean> {
  const perms = await getEffectivePermissions(db, serverId, actorId);
  return perms.has(permission);
}

export async function hasAllPermissions(
  db: Db,
  serverId: string,
  actorId: string,
  permissions: Permission[],
): Promise<boolean> {
  if (permissions.length === 0) return true;
  const perms = await getEffectivePermissions(db, serverId, actorId);
  return permissions.every((p) => perms.has(p));
}

/**
 * Count the number of server members whose effective permissions
 * include `MANAGE_ROLES`. Used by the lockout-prevention invariant.
 *
 * Two sources of MANAGE_ROLES:
 *   1. The server's @everyone default role has it (rare but possible).
 *   2. The actor is assigned to any role that has it.
 *
 * Evaluated against live DB state, never cached — the caller is
 * about to mutate and needs a fresh answer post-mutation.
 */
export async function countManageRolesHolders(
  db: Db,
  serverId: string,
): Promise<number> {
  // Case 1: @everyone has MANAGE_ROLES — every server member qualifies.
  const [defaultRole] = await db
    .select({ permissions: serverRoles.permissions })
    .from(serverRoles)
    .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isDefault, true)))
    .limit(1);

  if ((defaultRole?.permissions ?? []).includes(PERMISSIONS.MANAGE_ROLES)) {
    const [server] = await db
      .select({ followersUri: actors.followersUri })
      .from(actors)
      .where(eq(actors.id, serverId))
      .limit(1);
    if (!server?.followersUri) return 0;
    const members = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(eq(collectionItems.collectionUri, server.followersUri));
    return members.length;
  }

  // Case 2: Count distinct actors assigned to any role that grants
  // MANAGE_ROLES. Fetch all roles on this server, filter in JS (cheap:
  // ~3-10 roles per server), then count distinct assignees across them.
  const allRoles = await db
    .select({ id: serverRoles.id, permissions: serverRoles.permissions })
    .from(serverRoles)
    .where(eq(serverRoles.serverId, serverId));

  const managingRoleIds = allRoles
    .filter((r) => (r.permissions ?? []).includes(PERMISSIONS.MANAGE_ROLES))
    .map((r) => r.id);

  if (managingRoleIds.length === 0) return 0;

  const assignees = await db
    .selectDistinct({ actorId: serverRoleAssignments.actorId })
    .from(serverRoleAssignments)
    .where(
      and(
        eq(serverRoleAssignments.serverId, serverId),
        inArray(serverRoleAssignments.roleId, managingRoleIds),
      ),
    );
  return assignees.length;
}

/**
 * Lockout-prevention invariant. Call *inside* a mutation transaction
 * *after* applying the mutation. Throws `LockoutError` if the mutation
 * would leave the server with zero members able to manage roles.
 *
 * When the caller's transaction catches the throw and rolls back, the
 * mutation is surfaced to the user as a clean 400 rather than
 * silently bricking their server.
 */
export class LockoutError extends Error {
  constructor() {
    super(
      'This change would leave the server with no one able to manage roles. ' +
        'Assign MANAGE_ROLES to another member first.',
    );
    this.name = 'LockoutError';
  }
}

export async function ensureManageRolesSurvives(db: Db, serverId: string): Promise<void> {
  const count = await countManageRolesHolders(db, serverId);
  if (count === 0) {
    throw new LockoutError();
  }
}
