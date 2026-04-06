// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { activities } from '../db/schema/activities.ts';
import { collectionItems } from '../db/schema/collections.ts';
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

    // Add creator as member
    await db.insert(collectionItems).values({
      collectionUri: server.followersUri!,
      collectionId: null,
      itemUri: actor.uri,
      itemId: actor.id,
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
}
