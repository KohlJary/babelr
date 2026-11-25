// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/schema/actors.ts';
import { objects } from '../../db/schema/objects.ts';
import { collectionItems } from '../../db/schema/collections.ts';
import { serverRoles, serverRoleAssignments } from '../../db/schema/roles.ts';
import { ensureDefaultRoles } from '../../plugins/seed.ts';

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

/** The default server the way the seed plugin makes it: a public Group
 *  with a #general channel and, before the fix, no roles at all. */
async function seededServerWithMember() {
  const uri = 'http://test.babelr.local/groups/babelr';
  const [server] = await db
    .insert(actors)
    .values({
      type: 'Group',
      preferredUsername: 'babelr',
      displayName: 'Babelr',
      uri,
      inboxUri: `${uri}/inbox`,
      outboxUri: `${uri}/outbox`,
      followersUri: `${uri}/followers`,
      followingUri: `${uri}/following`,
      local: true,
      properties: { public: true },
    })
    .returning();
  await db.insert(objects).values({
    uri: 'http://test.babelr.local/channels/general',
    type: 'OrderedCollection',
    belongsTo: server.id,
    properties: { name: 'general' },
  });
  // The instance's first user is auto-joined to it as owner.
  const owner = await createTestUser(app, 'alice');
  const ownerMe = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner.cookie } })).body,
  );
  const user = await createTestUser(app, 'bob');
  const me = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: user.cookie } })).body,
  );
  await db.insert(collectionItems).values({
    collectionUri: server.followersUri!,
    collectionId: null,
    itemUri: me.uri,
    itemId: me.id,
    properties: { role: 'member' },
  });
  return { serverId: server.id, cookie: user.cookie, ownerId: ownerMe.id, memberId: me.id };
}

describe('seeded default server roles', () => {
  it('a member of a server without @everyone is refused; with it, sees channels and roles', async () => {
    const { serverId, cookie } = await seededServerWithMember();
    const get = (path: string) =>
      app.inject({ method: 'GET', url: `/servers/${serverId}/${path}`, headers: { cookie } });

    expect((await get('channels')).statusCode).toBe(403);
    expect((await get('roles')).statusCode).toBe(403);

    await ensureDefaultRoles(db, serverId);

    const channels = await get('channels');
    expect(channels.statusCode).toBe(200);
    expect(JSON.parse(channels.body).map((c: { name: string }) => c.name)).toContain('general');
    const roles = await get('roles');
    expect(roles.statusCode).toBe(200);
    expect(
      JSON.parse(roles.body)
        .roles.map((r: { name: string }) => r.name)
        .sort(),
    ).toEqual(['@everyone', 'Admin', 'Moderator']);
  });

  it('gives the owner Admin and plain members only @everyone', async () => {
    const { serverId, ownerId, memberId } = await seededServerWithMember();
    await ensureDefaultRoles(db, serverId);
    const assigned = await db
      .select({ actorId: serverRoleAssignments.actorId, name: serverRoles.name })
      .from(serverRoleAssignments)
      .innerJoin(serverRoles, eq(serverRoles.id, serverRoleAssignments.roleId))
      .where(eq(serverRoleAssignments.serverId, serverId));
    expect(assigned).toEqual([{ actorId: ownerId, name: 'Admin' }]);
    expect(assigned.some((a) => a.actorId === memberId)).toBe(false);
  });

  it('a first user who registers after the seed gets Admin on the default server', async () => {
    const uri = 'http://test.babelr.local/groups/babelr';
    const [server] = await db
      .insert(actors)
      .values({
        type: 'Group',
        preferredUsername: 'babelr',
        uri,
        inboxUri: `${uri}/inbox`,
        outboxUri: `${uri}/outbox`,
        followersUri: `${uri}/followers`,
        followingUri: `${uri}/following`,
        local: true,
      })
      .returning();
    await ensureDefaultRoles(db, server.id);
    const owner = await createTestUser(app, 'carol');
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${server.id}/roles`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const assigned = await db
      .select({ name: serverRoles.name })
      .from(serverRoleAssignments)
      .innerJoin(serverRoles, eq(serverRoles.id, serverRoleAssignments.roleId))
      .where(eq(serverRoleAssignments.serverId, server.id));
    expect(assigned).toEqual([{ name: 'Admin' }]);
  });

  it('is idempotent and leaves existing roles alone', async () => {
    const { serverId } = await seededServerWithMember();
    await ensureDefaultRoles(db, serverId);
    await ensureDefaultRoles(db, serverId);
    const rows = await db.select().from(serverRoles).where(eq(serverRoles.serverId, serverId));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it('adds only @everyone when other roles already exist', async () => {
    const { serverId } = await seededServerWithMember();
    await db.insert(serverRoles).values({
      serverId,
      name: 'Gardener',
      position: 5,
      permissions: [],
      isDefault: false,
      isSystem: false,
    });
    await ensureDefaultRoles(db, serverId);
    const rows = await db.select().from(serverRoles).where(eq(serverRoles.serverId, serverId));
    expect(rows.map((r) => r.name).sort()).toEqual(['@everyone', 'Gardener']);
  });
});
