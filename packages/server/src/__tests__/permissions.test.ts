// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../db/index.ts';
import { and, eq } from 'drizzle-orm';
import { PERMISSIONS } from '@babelr/shared';
import {
  getEffectivePermissions,
  hasPermission,
  hasAllPermissions,
  countManageRolesHolders,
  ensureManageRolesSurvives,
  LockoutError,
} from '../permissions.ts';
import { serverRoles, serverRoleAssignments } from '../db/schema/roles.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { actors } from '../db/schema/actors.ts';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

/**
 * Spin up a fresh server with its creator, returning the ids we
 * need for permission tests. Leverages the server-create route so
 * we exercise the same bootstrap path production uses — default
 * roles get created and the creator gets assigned to Admin.
 */
async function createServerWithCreator() {
  const creator = await createTestUser(app, 'creator');
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: creator.cookie },
    payload: { name: 'Test Server', description: 'permissions test' },
  });
  const server = JSON.parse(serverRes.body);
  return { creator, serverId: server.id };
}

async function addMemberToServer(
  cookie: string,
  serverId: string,
): Promise<void> {
  // Use the join-by-invite flow for realism: create invite as admin,
  // join as the new user.
  // But the existing servers.ts route structure is a bit awkward here;
  // shortcut by directly inserting a membership row.
  const [server] = await db.select().from(actors).where(eq(actors.id, serverId)).limit(1);
  // Grab the cookie-associated actor. Using /auth/me.
  const meRes = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { cookie },
  });
  const me = JSON.parse(meRes.body);
  await db.insert(collectionItems).values({
    collectionUri: server!.followersUri!,
    collectionId: null,
    itemUri: me.uri,
    itemId: me.id,
    properties: { role: 'member' },
  });
}

describe('getEffectivePermissions', () => {
  it('returns an empty set for a non-member', async () => {
    const { serverId } = await createServerWithCreator();
    const stranger = await createTestUser(app, 'stranger');
    const strangerRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: stranger.cookie },
    });
    const strangerMe = JSON.parse(strangerRes.body);

    const perms = await getEffectivePermissions(db, serverId, strangerMe.id);
    expect(perms.size).toBe(0);
  });

  it('returns @everyone permissions for a plain member', async () => {
    const { serverId } = await createServerWithCreator();
    const member = await createTestUser(app, 'member');
    await addMemberToServer(member.cookie, serverId);
    const memberRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: member.cookie },
    });
    const memberMe = JSON.parse(memberRes.body);

    const perms = await getEffectivePermissions(db, serverId, memberMe.id);

    // @everyone grants the member-tier perms but NOT the admin ones.
    expect(perms.has(PERMISSIONS.VIEW_CHANNELS)).toBe(true);
    expect(perms.has(PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(perms.has(PERMISSIONS.VIEW_WIKI)).toBe(true);
    expect(perms.has(PERMISSIONS.CREATE_EVENTS)).toBe(true);
    expect(perms.has(PERMISSIONS.CONNECT_VOICE)).toBe(true);

    expect(perms.has(PERMISSIONS.MANAGE_SERVER)).toBe(false);
    expect(perms.has(PERMISSIONS.MANAGE_ROLES)).toBe(false);
    expect(perms.has(PERMISSIONS.KICK_MEMBERS)).toBe(false);
    expect(perms.has(PERMISSIONS.MANAGE_CHANNELS)).toBe(false);
  });

  it('returns admin permissions for the creator (auto-assigned to Admin)', async () => {
    const { creator, serverId } = await createServerWithCreator();
    const creatorRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: creator.cookie },
    });
    const creatorMe = JSON.parse(creatorRes.body);

    const perms = await getEffectivePermissions(db, serverId, creatorMe.id);

    // Admin gets everything the default roles define.
    expect(perms.has(PERMISSIONS.MANAGE_SERVER)).toBe(true);
    expect(perms.has(PERMISSIONS.MANAGE_ROLES)).toBe(true);
    expect(perms.has(PERMISSIONS.KICK_MEMBERS)).toBe(true);
    expect(perms.has(PERMISSIONS.MANAGE_CHANNELS)).toBe(true);
    expect(perms.has(PERMISSIONS.MANAGE_MESSAGES)).toBe(true);
    expect(perms.has(PERMISSIONS.MANAGE_WIKI)).toBe(true);
    // Plus @everyone perms are included.
    expect(perms.has(PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(perms.has(PERMISSIONS.CREATE_EVENTS)).toBe(true);
  });

  it('unions permissions across multiple assigned roles', async () => {
    const { serverId } = await createServerWithCreator();
    const member = await createTestUser(app, 'multirole');
    await addMemberToServer(member.cookie, serverId);
    const memberRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: member.cookie },
    });
    const memberMe = JSON.parse(memberRes.body);

    // Create a narrow custom role that grants only MANAGE_CHANNELS.
    const [narrowRole] = await db
      .insert(serverRoles)
      .values({
        serverId,
        name: 'ChannelJanitor',
        color: null,
        position: 5,
        permissions: [PERMISSIONS.MANAGE_CHANNELS],
        isDefault: false,
        isSystem: false,
      })
      .returning();

    // Create a second custom role that grants only MANAGE_EVENTS.
    const [eventRole] = await db
      .insert(serverRoles)
      .values({
        serverId,
        name: 'EventManager',
        color: null,
        position: 6,
        permissions: [PERMISSIONS.MANAGE_EVENTS],
        isDefault: false,
        isSystem: false,
      })
      .returning();

    // Assign the member to both.
    await db.insert(serverRoleAssignments).values([
      { serverId, actorId: memberMe.id, roleId: narrowRole.id },
      { serverId, actorId: memberMe.id, roleId: eventRole.id },
    ]);

    const perms = await getEffectivePermissions(db, serverId, memberMe.id);

    // Should have @everyone + both role grants.
    expect(perms.has(PERMISSIONS.SEND_MESSAGES)).toBe(true); // @everyone
    expect(perms.has(PERMISSIONS.MANAGE_CHANNELS)).toBe(true); // ChannelJanitor
    expect(perms.has(PERMISSIONS.MANAGE_EVENTS)).toBe(true); // EventManager
    // But NOT things not granted by any of those three.
    expect(perms.has(PERMISSIONS.MANAGE_ROLES)).toBe(false);
    expect(perms.has(PERMISSIONS.KICK_MEMBERS)).toBe(false);
  });
});

describe('hasPermission / hasAllPermissions', () => {
  it('hasPermission returns true only for granted permissions', async () => {
    const { creator, serverId } = await createServerWithCreator();
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: creator.cookie } })).body);

    expect(await hasPermission(db, serverId, me.id, PERMISSIONS.MANAGE_SERVER)).toBe(true);
    expect(await hasPermission(db, serverId, me.id, PERMISSIONS.SEND_MESSAGES)).toBe(true);
  });

  it('hasAllPermissions requires every permission to be present', async () => {
    const { serverId } = await createServerWithCreator();
    const member = await createTestUser(app, 'allperms');
    await addMemberToServer(member.cookie, serverId);
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: member.cookie } })).body);

    // Member has SEND_MESSAGES but not MANAGE_SERVER.
    expect(
      await hasAllPermissions(db, serverId, me.id, [
        PERMISSIONS.SEND_MESSAGES,
        PERMISSIONS.VIEW_WIKI,
      ]),
    ).toBe(true);
    expect(
      await hasAllPermissions(db, serverId, me.id, [
        PERMISSIONS.SEND_MESSAGES,
        PERMISSIONS.MANAGE_SERVER,
      ]),
    ).toBe(false);
  });

  it('empty permission array always returns true (trivially satisfied)', async () => {
    const { serverId } = await createServerWithCreator();
    const stranger = await createTestUser(app, 'novoid');
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: stranger.cookie } })).body);
    expect(await hasAllPermissions(db, serverId, me.id, [])).toBe(true);
  });
});

describe('countManageRolesHolders / ensureManageRolesSurvives', () => {
  it('counts exactly one holder right after server creation (the creator)', async () => {
    const { serverId } = await createServerWithCreator();
    expect(await countManageRolesHolders(db, serverId)).toBe(1);
  });

  it('counts multiple holders when several members are assigned Admin', async () => {
    const { serverId } = await createServerWithCreator();
    const m1 = await createTestUser(app, 'alpha');
    const m2 = await createTestUser(app, 'beta');
    await addMemberToServer(m1.cookie, serverId);
    await addMemberToServer(m2.cookie, serverId);

    const m1Me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: m1.cookie } })).body);
    const m2Me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: m2.cookie } })).body);

    const [adminRole] = await db
      .select()
      .from(serverRoles)
      .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, 'Admin')))
      .limit(1);

    await db.insert(serverRoleAssignments).values([
      { serverId, actorId: m1Me.id, roleId: adminRole.id },
      { serverId, actorId: m2Me.id, roleId: adminRole.id },
    ]);

    expect(await countManageRolesHolders(db, serverId)).toBe(3);
  });

  it('ensureManageRolesSurvives throws LockoutError when count reaches zero', async () => {
    const { creator, serverId } = await createServerWithCreator();
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: creator.cookie } })).body);

    // Simulate the mutation: unassign the creator from Admin.
    const [adminRole] = await db
      .select()
      .from(serverRoles)
      .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, 'Admin')))
      .limit(1);
    await db
      .delete(serverRoleAssignments)
      .where(
        and(
          eq(serverRoleAssignments.serverId, serverId),
          eq(serverRoleAssignments.actorId, me.id),
          eq(serverRoleAssignments.roleId, adminRole.id),
        ),
      );

    await expect(ensureManageRolesSurvives(db, serverId)).rejects.toThrow(LockoutError);
  });

  it('ensureManageRolesSurvives passes when at least one holder remains', async () => {
    const { serverId } = await createServerWithCreator();
    // Creator is still Admin — invariant satisfied.
    await expect(ensureManageRolesSurvives(db, serverId)).resolves.toBeUndefined();
  });
});

describe('server creation bootstrap', () => {
  it('creates exactly three default roles on new server creation', async () => {
    const { serverId } = await createServerWithCreator();
    const roles = await db
      .select()
      .from(serverRoles)
      .where(eq(serverRoles.serverId, serverId));
    expect(roles).toHaveLength(3);
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual(['@everyone', 'Admin', 'Moderator']);
  });

  it('marks @everyone as isDefault + isSystem, leaves the other two unmarked', async () => {
    const { serverId } = await createServerWithCreator();
    const roles = await db
      .select()
      .from(serverRoles)
      .where(eq(serverRoles.serverId, serverId));

    const everyone = roles.find((r) => r.name === '@everyone');
    const moderator = roles.find((r) => r.name === 'Moderator');
    const admin = roles.find((r) => r.name === 'Admin');

    expect(everyone?.isDefault).toBe(true);
    expect(everyone?.isSystem).toBe(true);
    expect(moderator?.isDefault).toBe(false);
    expect(moderator?.isSystem).toBe(false);
    expect(admin?.isDefault).toBe(false);
    expect(admin?.isSystem).toBe(false);
  });

  it('assigns the creator to the Admin role', async () => {
    const { creator, serverId } = await createServerWithCreator();
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: creator.cookie } })).body);

    const assignments = await db
      .select({ roleName: serverRoles.name })
      .from(serverRoleAssignments)
      .innerJoin(serverRoles, eq(serverRoles.id, serverRoleAssignments.roleId))
      .where(
        and(
          eq(serverRoleAssignments.serverId, serverId),
          eq(serverRoleAssignments.actorId, me.id),
        ),
      );

    expect(assignments).toHaveLength(1);
    expect(assignments[0].roleName).toBe('Admin');
  });
});
