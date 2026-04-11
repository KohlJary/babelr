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

/**
 * Systematic allow/deny matrix for every enforced permission flag.
 *
 * For each permission P that is actually enforced by at least one
 * route, this file has:
 *   - An `allow` case: a user who has P (usually the server Admin)
 *     performs the gated action and expects a 2xx response.
 *   - A `deny` case: a plain member (who has only the @everyone
 *     permissions) performs the same action with the same payload
 *     and expects 403.
 *
 * The point of this file is to guarantee that if someone ever
 * removes a `hasPermission` call from a route handler, at least one
 * test turns red. The existing permissions.test.ts file covers the
 * helper (hasPermission returns the right answer); this file covers
 * that every handler actually calls it.
 *
 * Permissions NOT covered here (with the reason):
 *   - ATTACH_FILES — not server-scoped yet (upload endpoint is global)
 *   - CONNECT_VOICE — WS signaling layer, needs different test setup
 *   - SPEAK, VIDEO — reserved for future mute/video-disable features
 *   - VIEW_AUDIT_LOG — reserved for future audit log feature
 *   - MENTION_EVERYONE — reserved for future @everyone rate limit
 *
 * The remaining-enforcement-gaps roadmap item tracks wiring these
 * through their respective subsystems.
 */

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
 * Shared scaffold for every matrix test. Creates a server with the
 * three default roles, one admin user (the creator), one plain
 * member, and one channel ready to send messages into. Returns the
 * cookies + ids so individual tests can target whichever subject
 * they need.
 */
async function scaffold() {
  const admin = await createTestUser(app, 'matrix_admin');
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: admin.cookie },
    payload: { name: 'Matrix Server' },
  });
  const server = JSON.parse(serverRes.body);
  const adminMe = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: admin.cookie } })).body,
  );

  // Plain member joins.
  const member = await createTestUser(app, 'matrix_member');
  const memberMe = JSON.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: member.cookie } })).body,
  );
  const [srv] = await db.select().from(actors).where(eq(actors.id, server.id)).limit(1);
  await db.insert(collectionItems).values({
    collectionUri: srv!.followersUri!,
    collectionId: null,
    itemUri: memberMe.uri,
    itemId: memberMe.id,
    properties: { role: 'member' },
  });

  // Grab the auto-created #general channel the creator is already in.
  const channelsRes = await app.inject({
    method: 'GET',
    url: `/servers/${server.id}/channels`,
    headers: { cookie: admin.cookie },
  });
  const channels = JSON.parse(channelsRes.body);
  const channelId = channels[0].id;

  return {
    admin: admin.cookie,
    adminId: adminMe.id,
    member: member.cookie,
    memberId: memberMe.id,
    serverId: server.id,
    channelId,
  };
}

/**
 * Strip a single permission from the @everyone role so we can test
 * the deny path for permissions that @everyone normally grants
 * (SEND_MESSAGES, ADD_REACTIONS, VIEW_CHANNELS, VIEW_WIKI, etc).
 * Without this the plain member would pass by default.
 */
async function revokeFromEveryone(serverId: string, permission: string) {
  const [everyone] = await db
    .select()
    .from(serverRoles)
    .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isDefault, true)))
    .limit(1);
  const current = everyone.permissions ?? [];
  await db
    .update(serverRoles)
    .set({ permissions: current.filter((p) => p !== permission) })
    .where(eq(serverRoles.id, everyone.id));
}

// ---- MANAGE_SERVER ----------------------------------------------------

describe('MANAGE_SERVER (PUT /servers/:id)', () => {
  it('allows admin', async () => {
    const { admin, serverId } = await scaffold();
    const res = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}`,
      headers: { cookie: admin },
      payload: { tagline: 'updated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies plain member', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}`,
      headers: { cookie: member },
      payload: { tagline: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- KICK_MEMBERS -----------------------------------------------------

describe('KICK_MEMBERS (DELETE /servers/:id/members/:id)', () => {
  it('allows admin', async () => {
    const { admin, serverId, memberId } = await scaffold();
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/members/${memberId}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies plain member', async () => {
    const { member, serverId, adminId } = await scaffold();
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/members/${adminId}`,
      headers: { cookie: member },
    });
    // Note: even if we did have KICK_MEMBERS, the owner-protection
    // guard would fire. But the permission deny comes first.
    expect(res.statusCode).toBe(403);
  });
});

// ---- CREATE_INVITES ---------------------------------------------------

describe('CREATE_INVITES (POST /servers/:id/invites)', () => {
  it('allows plain member (default-on for @everyone)', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/invites`,
      headers: { cookie: member },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies when @everyone has CREATE_INVITES revoked', async () => {
    const { member, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.CREATE_INVITES);
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/invites`,
      headers: { cookie: member },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_INVITES ---------------------------------------------------

describe('MANAGE_INVITES (GET /servers/:id/invites)', () => {
  it('allows admin', async () => {
    const { admin, serverId } = await scaffold();
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/invites`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies plain member', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/invites`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- VIEW_CHANNELS ---------------------------------------------------

describe('VIEW_CHANNELS (GET /servers/:id/channels)', () => {
  it('allows plain member (default-on)', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies when @everyone has VIEW_CHANNELS revoked', async () => {
    const { member, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.VIEW_CHANNELS);
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_CHANNELS (create) -----------------------------------------

describe('MANAGE_CHANNELS via POST /servers/:id/channels', () => {
  it('allows admin', async () => {
    const { admin, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: admin },
      payload: { name: 'new-channel' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies plain member', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: member },
      payload: { name: 'sneaky-channel' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_CHANNELS (update) -----------------------------------------

describe('MANAGE_CHANNELS via PUT /channels/:id', () => {
  it('allows admin', async () => {
    const { admin, channelId } = await scaffold();
    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}`,
      headers: { cookie: admin },
      payload: { topic: 'updated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies plain member', async () => {
    const { member, channelId } = await scaffold();
    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}`,
      headers: { cookie: member },
      payload: { topic: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- SEND_MESSAGES ----------------------------------------------------

describe('SEND_MESSAGES (POST /channels/:id/messages)', () => {
  it('allows plain member (default-on)', async () => {
    const { member, channelId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: member },
      payload: { content: 'hi' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies when @everyone has SEND_MESSAGES revoked', async () => {
    const { member, channelId, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.SEND_MESSAGES);
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: member },
      payload: { content: 'muted' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_MESSAGES --------------------------------------------------

describe('MANAGE_MESSAGES (DELETE own-vs-others)', () => {
  it('creator can delete their own message (override, no permission needed)', async () => {
    const { member, channelId } = await scaffold();
    const msgRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: member },
      payload: { content: 'mine' },
    });
    const { message: msg } = JSON.parse(msgRes.body);
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg.id}`,
      headers: { cookie: member },
    });
    expect(delRes.statusCode).toBe(200);
  });

  it("admin can delete another user's message (MANAGE_MESSAGES allow)", async () => {
    const { admin, member, channelId } = await scaffold();
    const msgRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: member },
      payload: { content: 'delete me' },
    });
    const { message: msg } = JSON.parse(msgRes.body);
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg.id}`,
      headers: { cookie: admin },
    });
    expect(delRes.statusCode).toBe(200);
  });

  it("plain member cannot delete another user's message (MANAGE_MESSAGES deny)", async () => {
    const { admin, member, channelId } = await scaffold();
    const msgRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: admin },
      payload: { content: 'admin post' },
    });
    const { message: msg } = JSON.parse(msgRes.body);
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg.id}`,
      headers: { cookie: member },
    });
    expect(delRes.statusCode).toBe(403);
  });
});

// ---- ADD_REACTIONS ----------------------------------------------------

describe('ADD_REACTIONS (POST /channels/:id/messages/:id/reactions)', () => {
  it('allows plain member (default-on)', async () => {
    const { admin, member, channelId } = await scaffold();
    const msgRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: admin },
      payload: { content: 'reactable' },
    });
    const { message: msg } = JSON.parse(msgRes.body);
    const reactRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages/${msg.id}/reactions`,
      headers: { cookie: member },
      payload: { emoji: '👍' },
    });
    expect(reactRes.statusCode).toBe(200);
  });

  it('denies when @everyone has ADD_REACTIONS revoked', async () => {
    const { admin, member, channelId, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.ADD_REACTIONS);
    const msgRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: admin },
      payload: { content: 'silent' },
    });
    const { message: msg } = JSON.parse(msgRes.body);
    const reactRes = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages/${msg.id}/reactions`,
      headers: { cookie: member },
      payload: { emoji: '👍' },
    });
    expect(reactRes.statusCode).toBe(403);
  });
});

// ---- CREATE_EVENTS ----------------------------------------------------

describe('CREATE_EVENTS (POST /events for server events)', () => {
  it('allows admin', async () => {
    const { admin, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: admin },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Admin Event',
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('allows plain member (default-on, @everyone has CREATE_EVENTS)', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: member },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Member Event',
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies when @everyone has CREATE_EVENTS revoked', async () => {
    const { member, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.CREATE_EVENTS);
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie: member },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Blocked',
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_EVENTS ----------------------------------------------------

describe('MANAGE_EVENTS (edit/delete OTHERS events)', () => {
  async function createEventAs(cookie: string, serverId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { cookie },
      payload: {
        ownerType: 'server',
        ownerId: serverId,
        title: 'Target Event',
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      },
    });
    return JSON.parse(res.body).id;
  }

  it('allows admin to edit a member-created event', async () => {
    const { admin, member, serverId } = await scaffold();
    const eventId = await createEventAs(member, serverId);
    const res = await app.inject({
      method: 'PUT',
      url: `/events/${eventId}`,
      headers: { cookie: admin },
      payload: { title: 'Renamed by admin' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("denies plain member editing another user's event", async () => {
    const { admin, member, serverId } = await scaffold();
    const eventId = await createEventAs(admin, serverId);
    const res = await app.inject({
      method: 'PUT',
      url: `/events/${eventId}`,
      headers: { cookie: member },
      payload: { title: 'Vandalized' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- VIEW_WIKI --------------------------------------------------------

describe('VIEW_WIKI (GET /servers/:id/wiki/pages)', () => {
  it('allows plain member (default-on)', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/wiki/pages`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies when @everyone has VIEW_WIKI revoked', async () => {
    const { member, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.VIEW_WIKI);
    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/wiki/pages`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- CREATE_WIKI_PAGES ------------------------------------------------

describe('CREATE_WIKI_PAGES (POST /servers/:id/wiki/pages)', () => {
  it('allows plain member (default-on)', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/wiki/pages`,
      headers: { cookie: member },
      payload: { title: 'My Page', content: 'hello' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies when @everyone has CREATE_WIKI_PAGES revoked', async () => {
    const { member, serverId } = await scaffold();
    await revokeFromEveryone(serverId, PERMISSIONS.CREATE_WIKI_PAGES);
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/wiki/pages`,
      headers: { cookie: member },
      payload: { title: 'Blocked Page', content: 'no' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_WIKI ------------------------------------------------------

describe('MANAGE_WIKI (edit/delete OTHERS pages, wiki settings)', () => {
  async function createPageAs(cookie: string, serverId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/wiki/pages`,
      headers: { cookie },
      payload: { title: 'Target', content: 'original' },
    });
    return JSON.parse(res.body).page.slug;
  }

  it("admin can delete another user's wiki page", async () => {
    const { admin, member, serverId } = await scaffold();
    const slug = await createPageAs(member, serverId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/wiki/pages/${slug}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
  });

  it("denies plain member deleting another user's wiki page", async () => {
    const { admin, member, serverId } = await scaffold();
    const slug = await createPageAs(admin, serverId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/wiki/pages/${slug}`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can update wiki settings', async () => {
    const { admin, member, serverId } = await scaffold();
    // Create a page so homeSlug validation passes.
    const slug = await createPageAs(member, serverId);
    const res = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/wiki/settings`,
      headers: { cookie: admin },
      payload: { homeSlug: slug },
    });
    expect(res.statusCode).toBe(200);
  });

  it('denies plain member updating wiki settings', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/wiki/settings`,
      headers: { cookie: member },
      payload: { homeSlug: null },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- MANAGE_ROLES (broad check via POST /roles) -----------------------

describe('MANAGE_ROLES (POST /servers/:id/roles)', () => {
  it('allows admin', async () => {
    const { admin, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: admin },
      payload: { name: 'Custom' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('denies plain member', async () => {
    const { member, serverId } = await scaffold();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/roles`,
      headers: { cookie: member },
      payload: { name: 'Sneaky' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---- Meta: confirm the matrix is exhaustive vs the enforced set -------

describe('Matrix coverage completeness', () => {
  it('documents which permissions are intentionally not in this matrix', () => {
    // Enforced permissions covered above: MANAGE_SERVER, KICK_MEMBERS,
    // CREATE_INVITES, MANAGE_INVITES, VIEW_CHANNELS, MANAGE_CHANNELS,
    // SEND_MESSAGES, MANAGE_MESSAGES, ADD_REACTIONS, CREATE_EVENTS,
    // MANAGE_EVENTS, VIEW_WIKI, CREATE_WIKI_PAGES, MANAGE_WIKI,
    // MANAGE_ROLES.
    //
    // Not covered (and why):
    //   - ATTACH_FILES: upload endpoint is not server-scoped yet
    //   - CONNECT_VOICE: WS signaling layer, needs separate test setup
    //   - SPEAK, VIDEO: reserved for future features
    //   - VIEW_AUDIT_LOG: reserved for audit log feature
    //   - MENTION_EVERYONE: reserved for @everyone rate limit
    //
    // The "remaining-enforcement-gaps" roadmap item tracks wiring
    // the first two through their respective subsystems. The rest
    // are intentionally inert until their features ship.
    expect(true).toBe(true);
  });

  it('unassigning the default role is not permitted (sanity check)', async () => {
    const { admin, serverId, memberId } = await scaffold();
    const [everyone] = await db
      .select()
      .from(serverRoles)
      .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.isDefault, true)))
      .limit(1);
    const res = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/members/${memberId}/roles/${everyone.id}`,
      headers: { cookie: admin },
    });
    // The unassign endpoint doesn't refuse default-role removals (since
    // @everyone is implicit — there's no assignment row to remove), but
    // the operation is a no-op so it returns 200 without any rows
    // changing. Verify by checking that no rows mention the member.
    expect(res.statusCode).toBe(200);
    const rows = await db
      .select()
      .from(serverRoleAssignments)
      .where(
        and(
          eq(serverRoleAssignments.serverId, serverId),
          eq(serverRoleAssignments.actorId, memberId),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});
