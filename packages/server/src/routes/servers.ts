// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { invites } from '../db/schema/invites.ts';
import { serverRoles, serverRoleAssignments } from '../db/schema/roles.ts';
import { DEFAULT_ROLE_DEFINITIONS, PERMISSIONS } from '@babelr/shared';
import type { CreateServerInput, ServerView, UpdateServerInput } from '@babelr/shared';
import { hasPermission, ensureManageRolesSurvives, LockoutError } from '../permissions.ts';
import { lookupActorByHandle } from '../federation/resolve.ts';
import { ensureActorKeys } from '../federation/keys.ts';
import { enqueueDelivery } from '../federation/delivery.ts';
import { serializeActivity } from '../federation/jsonld.ts';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function toServerView(
  server: typeof actors.$inferSelect,
  memberCount: number,
): ServerView {
  const props = (server.properties as Record<string, unknown> | null) ?? {};
  return {
    id: server.id,
    name: server.displayName ?? server.preferredUsername,
    description: server.summary,
    memberCount,
    tagline: (props.tagline as string | undefined) ?? null,
    longDescription: (props.longDescription as string | undefined) ?? null,
    logoUrl: (props.logoUrl as string | undefined) ?? null,
    tags: Array.isArray(props.tags) ? (props.tags as string[]) : [],
  };
}

export default async function serverRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  // Create a server
  fastify.post<{ Body: CreateServerInput }>('/servers', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { name, description } = request.body;
    if (!name || name.trim().length === 0) {
      return reply.status(400).send({ error: 'Server name is required' });
    }

    const slug = slugify(name);
    const actor = request.actor;
    const baseUri = `${protocol}://${config.domain}/groups/${slug}-${crypto.randomUUID().slice(0, 8)}`;

    // Create Group actor
    const [server] = await db
      .insert(actors)
      .values({
        type: 'Group',
        preferredUsername: slug,
        displayName: name.trim(),
        summary: description?.trim() ?? null,
        uri: baseUri,
        inboxUri: `${baseUri}/inbox`,
        outboxUri: `${baseUri}/outbox`,
        followersUri: `${baseUri}/followers`,
        followingUri: `${baseUri}/following`,
        local: true,
        properties: { ownerId: actor.id },
      })
      .returning();

    // Add creator as owner
    await db.insert(collectionItems).values({
      collectionUri: server.followersUri!,
      collectionId: null,
      itemUri: actor.uri,
      itemId: actor.id,
      properties: { role: 'owner' },
    });

    // Bootstrap the three default roles (@everyone, Moderator, Admin)
    // and assign the creator to Admin. The DEFAULT_ROLE_DEFINITIONS
    // constant in `@babelr/shared` is the single source of truth for
    // the default permission sets; keep it in sync with the migration
    // SQL in 0011_nasty_giant_man.sql when it changes.
    const insertedRoles = await db
      .insert(serverRoles)
      .values(
        DEFAULT_ROLE_DEFINITIONS.map((def) => ({
          serverId: server.id,
          name: def.name,
          color: def.color ?? null,
          position: def.position,
          permissions: [...def.permissions],
          isDefault: def.isDefault,
          isSystem: def.isSystem,
        })),
      )
      .returning();

    const adminRole = insertedRoles.find((r) => r.name === 'Admin');
    if (adminRole) {
      await db.insert(serverRoleAssignments).values({
        serverId: server.id,
        actorId: actor.id,
        roleId: adminRole.id,
      });
    }

    // Create Follow activity
    await db.insert(activities).values({
      uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
      type: 'Follow',
      actorId: actor.id,
      objectUri: server.uri,
    });

    // Create default #general channel
    await db.insert(objects).values({
      uri: `${baseUri}/channels/general`,
      type: 'OrderedCollection',
      belongsTo: server.id,
      properties: { name: 'general' },
    });

    return reply.status(201).send(toServerView(server, 1));
  });

  // List servers the user is a member of
  fastify.get('/servers', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const actor = request.actor;

    // Find all collection_items where the user is a member
    const memberships = await db
      .select({ collectionUri: collectionItems.collectionUri })
      .from(collectionItems)
      .where(eq(collectionItems.itemUri, actor.uri));

    if (memberships.length === 0) {
      return [];
    }

    const followerUris = memberships.map((m) => m.collectionUri);

    // Find Group actors whose followersUri matches — includes both
    // local servers and remote servers the user has joined via
    // federation, so cross-instance memberships show up in the sidebar.
    const servers = await db
      .select()
      .from(actors)
      .where(eq(actors.type, 'Group'));

    const results: ServerView[] = [];
    for (const server of servers) {
      if (!server.followersUri || !followerUris.includes(server.followersUri)) continue;

      // Count members
      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, server.followersUri));

      results.push(toServerView(server, count?.count ?? 0));
    }

    return results;
  });

  // Discover all servers (for join dialog)
  fastify.get('/servers/discover', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const actor = request.actor;

    // Get user's current memberships
    const memberships = await db
      .select({ collectionUri: collectionItems.collectionUri })
      .from(collectionItems)
      .where(eq(collectionItems.itemUri, actor.uri));

    const memberUris = new Set(memberships.map((m) => m.collectionUri));

    // Get all local Group actors
    const servers = await db
      .select()
      .from(actors)
      .where(and(eq(actors.type, 'Group'), eq(actors.local, true)));

    const results = [];
    for (const server of servers) {
      if (!server.followersUri) continue;

      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, server.followersUri));

      results.push({
        ...toServerView(server, count?.count ?? 0),
        joined: memberUris.has(server.followersUri),
      });
    }

    return results;
  });

  // Get server details
  fastify.get<{ Params: { serverId: string } }>('/servers/:serverId', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const [server] = await db
      .select()
      .from(actors)
      .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
      .limit(1);

    if (!server) {
      return reply.status(404).send({ error: 'Server not found' });
    }

    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(collectionItems)
      .where(eq(collectionItems.collectionUri, server.followersUri!));

    return toServerView(server, count?.count ?? 0);
  });

  // Update server info (admin+ only)
  fastify.put<{ Params: { serverId: string }; Body: UpdateServerInput }>(
    '/servers/:serverId',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      if (!(await hasPermission(db, server.id, request.actor.id, PERMISSIONS.MANAGE_SERVER))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const { name, description, tagline, longDescription, logoUrl, tags } = request.body ?? {};
      const updates: Record<string, unknown> = {};

      if (name !== undefined) {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          return reply.status(400).send({ error: 'Server name cannot be empty' });
        }
        updates.displayName = trimmed;
      }

      if (description !== undefined) {
        updates.summary = description?.trim() || null;
      }

      // Custom properties
      const currentProps = (server.properties as Record<string, unknown> | null) ?? {};
      const nextProps = { ...currentProps };
      if (tagline !== undefined) nextProps.tagline = tagline?.trim() || null;
      if (longDescription !== undefined) nextProps.longDescription = longDescription?.trim() || null;
      if (logoUrl !== undefined) nextProps.logoUrl = logoUrl || null;
      if (tags !== undefined) {
        const cleaned = Array.from(
          new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 32)),
        ).slice(0, 10);
        nextProps.tags = cleaned;
      }
      updates.properties = nextProps;

      const [updated] = await db
        .update(actors)
        .set(updates)
        .where(eq(actors.id, server.id))
        .returning();

      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, updated.followersUri!));

      return toServerView(updated, count?.count ?? 0);
    },
  );

  // Join a server
  fastify.post<{ Params: { serverId: string } }>(
    '/servers/:serverId/join',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server || !server.followersUri) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      const actor = request.actor;

      // Check if already a member
      const [existing] = await db
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, actor.uri),
          ),
        )
        .limit(1);

      if (existing) {
        return { ok: true };
      }

      await db.insert(collectionItems).values({
        collectionUri: server.followersUri,
        collectionId: null,
        itemUri: actor.uri,
        itemId: actor.id,
      });

      await db.insert(activities).values({
        uri: `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
        type: 'Follow',
        actorId: actor.id,
        objectUri: server.uri,
      });

      return { ok: true };
    },
  );

  // Leave a server
  fastify.post<{ Params: { serverId: string } }>(
    '/servers/:serverId/leave',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server || !server.followersUri) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      // Prevent owner from leaving
      const props = server.properties as Record<string, unknown> | null;
      if (props?.ownerId === request.actor.id) {
        return reply.status(400).send({ error: 'Server owner cannot leave' });
      }

      await db
        .delete(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, request.actor.uri),
          ),
        );

      return { ok: true };
    },
  );

  // Join a remote server by handle (e.g. test-server@babelr-a.local:3000).
  // Resolves the Group actor via WebFinger, caches it locally, sends a
  // Follow activity to the remote inbox, and optimistically adds
  // membership since Groups auto-accept. The server appears in the
  // user's sidebar once the local collectionItems row is created.
  fastify.post<{ Body: { handle: string } }>(
    '/servers/join-remote',
    async (request, reply) => {
      if (!request.actor)
        return reply.status(401).send({ error: 'Not authenticated' });

      const raw = (request.body?.handle ?? '').trim().replace(/^@/, '');
      if (!raw)
        return reply.status(400).send({ error: 'handle is required' });

      const remoteGroup = await lookupActorByHandle(db, raw);
      if (!remoteGroup || remoteGroup.type !== 'Group') {
        return reply.status(404).send({ error: 'Server not found' });
      }

      if (!remoteGroup.followersUri) {
        // Groups should always have a followersUri. If the remote
        // actor doesn't, synthesize one from the URI convention.
        return reply.status(400).send({ error: 'Remote server has no followers collection' });
      }

      // Check if already a member
      const [existing] = await db
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, remoteGroup.followersUri),
            eq(collectionItems.itemUri, request.actor.uri),
          ),
        )
        .limit(1);

      if (existing) {
        return { ok: true, server: toServerView(remoteGroup, 1) };
      }

      // Optimistically add the local membership — Groups auto-accept
      // Follows so we don't need to wait for the Accept round-trip.
      await db.insert(collectionItems).values({
        collectionUri: remoteGroup.followersUri,
        collectionId: null,
        itemUri: request.actor.uri,
        itemId: request.actor.id,
        properties: { role: 'member' },
      });

      // Enqueue the Follow activity so the remote instance knows
      // about the new member and starts delivering channel messages.
      const actorWithKeys = await ensureActorKeys(db, request.actor);
      if (actorWithKeys.privateKeyPem && remoteGroup.inboxUri) {
        const activityUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
        const activity = serializeActivity(
          activityUri,
          'Follow',
          request.actor.uri,
          remoteGroup.uri,
          [remoteGroup.uri],
          [],
        );
        await enqueueDelivery(db, activity, remoteGroup.inboxUri, request.actor.id);
      }

      return { ok: true, server: toServerView(remoteGroup, 1) };
    },
  );

  // List server members with roles
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/members',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, request.params.serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server?.followersUri) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      const members = await db
        .select({ member: actors, item: collectionItems })
        .from(collectionItems)
        .innerJoin(actors, eq(collectionItems.itemId, actors.id))
        .where(eq(collectionItems.collectionUri, server.followersUri));

      // Batch-load role assignments for every member so the client
      // can render multi-role chips without an N+1 query. Group by
      // actorId into a Map for O(1) lookup during the response map.
      const assignmentRows = await db
        .select()
        .from(serverRoleAssignments)
        .where(eq(serverRoleAssignments.serverId, request.params.serverId));
      const roleIdsByActor = new Map<string, string[]>();
      for (const row of assignmentRows) {
        const list = roleIdsByActor.get(row.actorId) ?? [];
        list.push(row.roleId);
        roleIdsByActor.set(row.actorId, list);
      }

      return members.map((m) => {
        const itemProps = m.item.properties as Record<string, unknown> | null;
        const memberProps = m.member.properties as Record<string, unknown> | null;
        return {
          id: m.member.id,
          preferredUsername: m.member.preferredUsername,
          displayName: m.member.displayName,
          role: (itemProps?.role as string) ?? 'member',
          roleIds: roleIdsByActor.get(m.member.id) ?? [],
          avatarUrl: (memberProps?.avatarUrl as string | undefined) ?? null,
        };
      });
    },
  );

  // Set member role (owner only)
  fastify.put<{ Params: { serverId: string; userId: string }; Body: { role: string } }>(
    '/servers/:serverId/members/:userId/role',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { serverId, userId } = request.params;
      const { role } = request.body;

      if (!['admin', 'moderator', 'member'].includes(role)) {
        return reply.status(400).send({ error: 'Invalid role' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server?.followersUri) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      if (!(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.MANAGE_ROLES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      // Cannot change your own role via this endpoint — prevents
      // accidentally demoting yourself out of MANAGE_ROLES. The lockout
      // invariant would catch it anyway, but failing fast with a
      // clearer error is nicer UX.
      if (userId === request.actor.id) {
        return reply.status(400).send({ error: "Cannot change your own role" });
      }

      const [target] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, userId))
        .limit(1);

      if (!target) {
        return reply.status(404).send({ error: 'User not found' });
      }

      // Resolve the target role from the requested string. 'member'
      // means "clear all Admin/Moderator assignments, fall back to
      // @everyone implicitly" — no row inserted.
      const [adminRole] = await db
        .select()
        .from(serverRoles)
        .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, 'Admin')))
        .limit(1);
      const [moderatorRole] = await db
        .select()
        .from(serverRoles)
        .where(and(eq(serverRoles.serverId, serverId), eq(serverRoles.name, 'Moderator')))
        .limit(1);

      try {
        await db.transaction(async (tx) => {
          // Update the legacy role string for back-compat (display
          // code still reads it; PR3 migrates the reader to the new
          // role-assignment tables).
          await tx
            .update(collectionItems)
            .set({ properties: { role } })
            .where(
              and(
                eq(collectionItems.collectionUri, server.followersUri!),
                eq(collectionItems.itemUri, target.uri),
              ),
            );

          // Clear existing Admin/Moderator assignments for this user.
          const roleIdsToClear = [adminRole?.id, moderatorRole?.id].filter(
            (x): x is string => !!x,
          );
          if (roleIdsToClear.length > 0) {
            for (const roleId of roleIdsToClear) {
              await tx
                .delete(serverRoleAssignments)
                .where(
                  and(
                    eq(serverRoleAssignments.serverId, serverId),
                    eq(serverRoleAssignments.actorId, userId),
                    eq(serverRoleAssignments.roleId, roleId),
                  ),
                );
            }
          }

          // Insert the new assignment if applicable.
          const newRoleId =
            role === 'admin' ? adminRole?.id : role === 'moderator' ? moderatorRole?.id : null;
          if (newRoleId) {
            await tx.insert(serverRoleAssignments).values({
              serverId,
              actorId: userId,
              roleId: newRoleId,
            });
          }

          // Verify the lockout invariant still holds after the change.
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

  // Kick member (admin+ only)
  fastify.delete<{ Params: { serverId: string; userId: string } }>(
    '/servers/:serverId/members/:userId',
    async (request, reply) => {
      if (!request.actor) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { serverId, userId } = request.params;

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server?.followersUri) {
        return reply.status(404).send({ error: 'Server not found' });
      }

      if (!(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.KICK_MEMBERS))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      // Cannot kick yourself via this endpoint — use /servers/:id/leave
      // instead. The lockout invariant would catch the last-admin
      // self-kick anyway, but failing fast is clearer.
      if (userId === request.actor.id) {
        return reply.status(400).send({ error: 'Use /leave to remove yourself' });
      }

      // Cannot kick the server owner. Owner transfer is a deferred
      // feature; for now the ownerId property is the identity of
      // whoever created the server, and they're protected.
      const serverProps = server.properties as Record<string, unknown> | null;
      if (serverProps?.ownerId === userId) {
        return reply.status(400).send({ error: 'Cannot kick the server owner' });
      }

      const [target] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, userId))
        .limit(1);

      if (!target) {
        return reply.status(404).send({ error: 'User not found' });
      }

      try {
        await db.transaction(async (tx) => {
          // Remove membership from the server's followers collection.
          await tx
            .delete(collectionItems)
            .where(
              and(
                eq(collectionItems.collectionUri, server.followersUri!),
                eq(collectionItems.itemUri, target.uri),
              ),
            );

          // Remove any role assignments for this member on this server.
          // The FK from server_role_assignments.actorId → actors.id has
          // ON DELETE CASCADE but that fires on actor deletion, not
          // kick — so we clean up explicitly here.
          await tx
            .delete(serverRoleAssignments)
            .where(
              and(
                eq(serverRoleAssignments.serverId, serverId),
                eq(serverRoleAssignments.actorId, userId),
              ),
            );

          // Verify the lockout invariant still holds.
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

  // Create invite link for a server
  fastify.post<{ Params: { serverId: string }; Body: { maxUses?: number; expiresInHours?: number } }>(
    '/servers/:serverId/invites',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const { serverId } = request.params;
      const { maxUses, expiresInHours } = request.body ?? {};

      const [server] = await db
        .select()
        .from(actors)
        .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
        .limit(1);

      if (!server) return reply.status(404).send({ error: 'Server not found' });

      if (!(await hasPermission(db, serverId, request.actor.id, PERMISSIONS.CREATE_INVITES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const expiresAt = expiresInHours
        ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
        : null;

      const [invite] = await db
        .insert(invites)
        .values({
          code,
          serverId,
          createdBy: request.actor.id,
          maxUses: maxUses ?? null,
          expiresAt,
        })
        .returning();

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      return reply.status(201).send({
        code: invite.code,
        url: `${protocol}://${config.domain}/invite/${invite.code}`,
        maxUses: invite.maxUses,
        expiresAt: invite.expiresAt?.toISOString() ?? null,
      });
    },
  );

  // Join via invite code
  fastify.post<{ Params: { code: string } }>(
    '/invites/:code/join',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [invite] = await db
        .select()
        .from(invites)
        .where(eq(invites.code, request.params.code))
        .limit(1);

      if (!invite) return reply.status(404).send({ error: 'Invalid invite code' });

      if (invite.expiresAt && invite.expiresAt < new Date()) {
        return reply.status(410).send({ error: 'Invite has expired' });
      }

      if (invite.maxUses && invite.uses >= invite.maxUses) {
        return reply.status(410).send({ error: 'Invite has been used up' });
      }

      const [server] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, invite.serverId))
        .limit(1);

      if (!server?.followersUri) return reply.status(404).send({ error: 'Server not found' });

      // Add member (idempotent)
      await db
        .insert(collectionItems)
        .values({
          collectionUri: server.followersUri,
          itemUri: request.actor.uri,
          itemId: request.actor.id,
        })
        .onConflictDoNothing();

      // Increment use count
      await db
        .update(invites)
        .set({ uses: invite.uses + 1 })
        .where(eq(invites.id, invite.id));

      return {
        ok: true,
        server: {
          id: server.id,
          name: server.displayName ?? server.preferredUsername,
        },
      };
    },
  );

  // List invites for a server (MANAGE_INVITES — previously ungated,
  // any member could enumerate every invite code)
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/invites',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      if (
        !(await hasPermission(
          db,
          request.params.serverId,
          request.actor.id,
          PERMISSIONS.MANAGE_INVITES,
        ))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      const serverInvites = await db
        .select()
        .from(invites)
        .where(eq(invites.serverId, request.params.serverId));

      const config = fastify.config;
      const protocol = config.secureCookies ? 'https' : 'http';

      return serverInvites.map((inv) => ({
        code: inv.code,
        url: `${protocol}://${config.domain}/invite/${inv.code}`,
        maxUses: inv.maxUses,
        uses: inv.uses,
        expiresAt: inv.expiresAt?.toISOString() ?? null,
        createdAt: inv.createdAt.toISOString(),
      }));
    },
  );
}
