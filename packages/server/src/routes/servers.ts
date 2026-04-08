// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { invites } from '../db/schema/invites.ts';
import type { CreateServerInput, ServerView } from '@babelr/shared';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
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

    const result: ServerView = {
      id: server.id,
      name: server.displayName ?? server.preferredUsername,
      description: server.summary,
      memberCount: 1,
    };
    return reply.status(201).send(result);
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

    // Find Group actors whose followersUri matches
    const servers = await db
      .select()
      .from(actors)
      .where(and(eq(actors.type, 'Group'), eq(actors.local, true)));

    const results: ServerView[] = [];
    for (const server of servers) {
      if (!server.followersUri || !followerUris.includes(server.followersUri)) continue;

      // Count members
      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, server.followersUri));

      results.push({
        id: server.id,
        name: server.displayName ?? server.preferredUsername,
        description: server.summary,
        memberCount: count?.count ?? 0,
      });
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
        id: server.id,
        name: server.displayName ?? server.preferredUsername,
        description: server.summary,
        memberCount: count?.count ?? 0,
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

    const result: ServerView = {
      id: server.id,
      name: server.displayName ?? server.preferredUsername,
      description: server.summary,
      memberCount: count?.count ?? 0,
    };
    return result;
  });

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

      return members.map((m) => {
        const itemProps = m.item.properties as Record<string, unknown> | null;
        return {
          id: m.member.id,
          preferredUsername: m.member.preferredUsername,
          displayName: m.member.displayName,
          role: (itemProps?.role as string) ?? 'member',
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

      // Only owner can set roles
      const serverProps = server.properties as Record<string, unknown> | null;
      if (serverProps?.ownerId !== request.actor.id) {
        return reply.status(403).send({ error: 'Only the server owner can manage roles' });
      }

      // Can't change owner's role
      if (userId === request.actor.id) {
        return reply.status(400).send({ error: "Cannot change owner's role" });
      }

      // Find the member's collection_items entry
      const [target] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, userId))
        .limit(1);

      if (!target) {
        return reply.status(404).send({ error: 'User not found' });
      }

      await db
        .update(collectionItems)
        .set({ properties: { role } })
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, target.uri),
          ),
        );

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

      // Check caller has admin+ role
      const [callerMembership] = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, request.actor.uri),
          ),
        )
        .limit(1);

      const callerProps = callerMembership?.properties as Record<string, unknown> | null;
      const callerRole = (callerProps?.role as string) ?? 'member';

      if (!['owner', 'admin'].includes(callerRole)) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      // Can't kick the owner
      const serverProps = server.properties as Record<string, unknown> | null;
      if (serverProps?.ownerId === userId) {
        return reply.status(400).send({ error: 'Cannot kick the server owner' });
      }

      // Find target user
      const [target] = await db
        .select()
        .from(actors)
        .where(eq(actors.id, userId))
        .limit(1);

      if (!target) {
        return reply.status(404).send({ error: 'User not found' });
      }

      await db
        .delete(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, target.uri),
          ),
        );

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

  // List invites for a server
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/invites',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

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
