// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { and, eq } from 'drizzle-orm';
import { PERMISSIONS } from '@babelr/shared';
import { collectionItems } from '../../db/schema/collections.ts';
import { actors } from '../../db/schema/actors.ts';
import { serverRoles, serverRoleAssignments } from '../../db/schema/roles.ts';

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

async function createServerAs(username: string) {
  const user = await createTestUser(app, username);
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: user.cookie },
    payload: { name: `${username}_server` },
  });
  const server = JSON.parse(serverRes.body);
  const me = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: user.cookie } })).body,
  );
  return { user, userId: me.id, serverId: server.id };
}

async function joinAsMember(cookie: string, serverId: string) {
  const [server] = await db.select().from(actors).where(eq(actors.id, serverId)).limit(1);
  const me = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body,
  );
  await db.insert(collectionItems).values({
    collectionUri: server!.followersUri!,
    collectionId: null,
    itemUri: me.uri,
    itemId: me.id,
    properties: { role: 'member' },
  });
  return me.id;
}

describe('GET /servers/:serverId/roles', () => {
  it('returns the three default roles for a fresh server', async () => {
    const { user, serverId } = await createServerAs('lister');
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { roles } = JSON.parse(res.body);
    expect(roles).toHaveLength(3);
    const names = roles.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['@everyone', 'Admin', 'Moderator']);
  });

  it('rejects non-members', async () => {
    const { serverId } = await createServerAs('owner');
    const stranger = await createTestUser(app, 'stranger');
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: stranger.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /servers/:serverId/roles', () => {
  it('creates a new role with validated permissions', async () => {
    const { user, serverId } = await createServerAs('creator');
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
      payload: {
        name: 'Channel Janitor',
        color: '#4b6cb7',
        permissions: [PERMISSIONS.MANAGE_CHANNELS, PERMISSIONS.VIEW_CHANNELS, 'BOGUS_PERM'],
      },
    });
    expect(res.statusCode).toBe(201);
    const { role } = JSON.parse(res.body);
    expect(role.name).toBe('Channel Janitor');
    expect(role.color).toBe('#4b6cb7');
    // BOGUS_PERM should be dropped; valid ones retained.
    expect(role.permissions).toContain(PERMISSIONS.MANAGE_CHANNELS);
    expect(role.permissions).toContain(PERMISSIONS.VIEW_CHANNELS);
    expect(role.permissions).not.toContain('BOGUS_PERM');
    expect(role.isSystem).toBe(false);
    expect(role.isDefault).toBe(false);
  });

  it('rejects a role name that collides with an existing role', async () => {
    const { user, serverId } = await createServerAs('dup');
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
      payload: { name: 'Admin' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a bad color string', async () => {
    const { user, serverId } = await createServerAs('bad_color');
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
      payload: { name: 'Broken', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when caller lacks MANAGE_ROLES', async () => {
    const { serverId } = await createServerAs('owner2');
    const member = await createTestUser(app, 'plain');
    await joinAsMember(member.cookie, serverId);
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: member.cookie },
      payload: { name: 'Some Role' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /servers/:serverId/roles/:roleId', () => {
  it('edits permissions on a system role (but not its name)', async () => {
    const { user, serverId } = await createServerAs('sysrole');
    const { roles } = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/roles`,
        headers: { cookie: user.cookie },
      })).body,
    );
    const everyone = roles.find((r: { name: string }) => r.name === '@everyone');

    // Renaming @everyone should fail.
    const renameRes = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/roles/${everyone.id}`,
      headers: { cookie: user.cookie },
      payload: { name: '@someoneelse' },
    });
    expect(renameRes.statusCode).toBe(400);

    // But editing its permissions should succeed.
    const permsRes = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/roles/${everyone.id}`,
      headers: { cookie: user.cookie },
      payload: { permissions: [PERMISSIONS.VIEW_CHANNELS] },
    });
    expect(permsRes.statusCode).toBe(200);
    const { role } = JSON.parse(permsRes.body);
    expect(role.permissions).toEqual([PERMISSIONS.VIEW_CHANNELS]);
  });

  it('rejects edit that would empty MANAGE_ROLES holders (lockout guard)', async () => {
    const { user, serverId } = await createServerAs('guard');
    const { roles } = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/roles`,
        headers: { cookie: user.cookie },
      })).body,
    );
    const admin = roles.find((r: { name: string }) => r.name === 'Admin');
    // Try to strip MANAGE_ROLES from the only role that currently grants it.
    const res = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/roles/${admin.id}`,
      headers: { cookie: user.cookie },
      payload: { permissions: [PERMISSIONS.VIEW_CHANNELS] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/manage roles/i);
  });
});

describe('DELETE /servers/:serverId/roles/:roleId', () => {
  it('rejects deleting a system role', async () => {
    const { user, serverId } = await createServerAs('delsys');
    const { roles } = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/roles`,
        headers: { cookie: user.cookie },
      })).body,
    );
    const everyone = roles.find((r: { name: string }) => r.name === '@everyone');
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/roles/${everyone.id}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects deleting the last MANAGE_ROLES role (lockout)', async () => {
    const { user, serverId } = await createServerAs('lastadmin');
    const { roles } = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/roles`,
        headers: { cookie: user.cookie },
      })).body,
    );
    const admin = roles.find((r: { name: string }) => r.name === 'Admin');
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/roles/${admin.id}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows deleting a non-system role that no one depends on', async () => {
    const { user, serverId } = await createServerAs('flex');
    // Create a throwaway role.
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
      payload: { name: 'Throwaway' },
    });
    const { role } = JSON.parse(createRes.body);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/roles/${role.id}`,
      headers: { cookie: user.cookie },
    });
    expect(deleteRes.statusCode).toBe(200);
  });
});

describe('Role assignment endpoints', () => {
  it('assigns and unassigns a role, reflected in GET /members', async () => {
    const { user, serverId } = await createServerAs('assigner');
    const member = await createTestUser(app, 'target');
    const memberId = await joinAsMember(member.cookie, serverId);

    // Create a custom role.
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: user.cookie },
      payload: { name: 'Helper', permissions: [PERMISSIONS.MANAGE_CHANNELS] },
    });
    const { role } = JSON.parse(createRes.body);

    // Assign.
    const assignRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/members/${memberId}/roles/${role.id}`,
      headers: { cookie: user.cookie },
    });
    expect(assignRes.statusCode).toBe(200);

    // Verify via members endpoint.
    const membersRes = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/members`,
      headers: { cookie: user.cookie },
    });
    const members = JSON.parse(membersRes.body);
    const target = members.find((m: { id: string }) => m.id === memberId);
    expect(target.roleIds).toContain(role.id);

    // Unassign.
    const unassignRes = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/members/${memberId}/roles/${role.id}`,
      headers: { cookie: user.cookie },
    });
    expect(unassignRes.statusCode).toBe(200);

    const membersAfter = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/members`,
        headers: { cookie: user.cookie },
      })).body,
    );
    const targetAfter = membersAfter.find((m: { id: string }) => m.id === memberId);
    expect(targetAfter.roleIds).not.toContain(role.id);
  });

  it('refuses to assign the implicit default role', async () => {
    const { user, serverId } = await createServerAs('dassign');
    const member = await createTestUser(app, 'dtarget');
    const memberId = await joinAsMember(member.cookie, serverId);
    const [everyone] = await db
      .select()
      .from(serverRoles)
      .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isDefault, true)))
      .limit(1);
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/members/${memberId}/roles/${everyone.id}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unassign that would empty MANAGE_ROLES holders', async () => {
    const { user, userId, serverId } = await createServerAs('unassigner');
    const [admin] = await db
      .select()
      .from(serverRoles)
      .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, 'Admin')))
      .limit(1);

    // Creator is the sole Admin — unassigning themselves would
    // leave zero MANAGE_ROLES holders.
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/members/${userId}/roles/${admin.id}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/manage roles/i);

    // Assignment should still exist.
    const [stillAssigned] = await db
      .select()
      .from(serverRoleAssignments)
      .where(
        and(
          eq(serverRoleAssignments.serverId, serverId),
          eq(serverRoleAssignments.actorId, userId),
          eq(serverRoleAssignments.roleId, admin.id),
        ),
      )
      .limit(1);
    expect(stillAssigned).toBeDefined();
  });
});
