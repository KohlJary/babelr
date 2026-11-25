// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import { DEFAULT_ROLE_DEFINITIONS } from '@babelr/shared';
import '../types.ts';
import type { Database } from '../db/index.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { serverRoles, serverRoleAssignments } from '../db/schema/roles.ts';
import { collectionItems } from '../db/schema/collections.ts';

/**
 * Every server needs its @everyone role: permissions are the union of
 * @everyone and assigned roles, so a member of a server without one has
 * no permissions at all and is told "Not a member of this server" by
 * every route. Servers created through the API get their roles at
 * creation; the seeded default server didn't, so give it the default
 * set (or just @everyone, if someone has since added other roles).
 */
export async function ensureDefaultRoles(db: Database, serverId: string): Promise<void> {
  const existing = await db
    .select({ isDefault: serverRoles.isDefault })
    .from(serverRoles)
    .where(eq(serverRoles.serverId, serverId));
  if (existing.some((r) => r.isDefault)) return;
  const defs =
    existing.length === 0
      ? DEFAULT_ROLE_DEFINITIONS
      : DEFAULT_ROLE_DEFINITIONS.filter((d) => d.isDefault);
  const inserted = await db
    .insert(serverRoles)
    .values(
      defs.map((def) => ({
        serverId,
        name: def.name,
        color: def.color ?? null,
        position: def.position,
        permissions: [...def.permissions],
        isDefault: def.isDefault,
        isSystem: def.isSystem,
      })),
    )
    .onConflictDoNothing()
    .returning();

  // The owner (the instance's first user, auto-joined at registration)
  // holds Admin, as the creator of any other server does.
  const admin = inserted.find((r) => r.name === 'Admin');
  if (!admin) return;
  const [server] = await db
    .select({ followersUri: actors.followersUri })
    .from(actors)
    .where(eq(actors.id, serverId))
    .limit(1);
  if (!server?.followersUri) return;
  const members = await db
    .select({ itemId: collectionItems.itemId, properties: collectionItems.properties })
    .from(collectionItems)
    .where(eq(collectionItems.collectionUri, server.followersUri));
  const owners = members.filter(
    (m) => m.itemId && (m.properties as { role?: string } | null)?.role === 'owner',
  );
  if (owners.length === 0) return;
  await db
    .insert(serverRoleAssignments)
    .values(owners.map((o) => ({ serverId, actorId: o.itemId!, roleId: admin.id })))
    .onConflictDoNothing();
}

async function seedPlugin(fastify: FastifyInstance) {
  fastify.addHook('onReady', async () => {
    const db = fastify.db;
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    const serverUri = `${protocol}://${config.domain}/groups/babelr`;
    const channelUri = `${protocol}://${config.domain}/channels/general`;

    // Upsert the default "Babelr" server (Group actor)
    let [server] = await db.select().from(actors).where(eq(actors.uri, serverUri)).limit(1);

    if (!server) {
      [server] = await db
        .insert(actors)
        .values({
          type: 'Group',
          preferredUsername: 'babelr',
          displayName: 'Babelr',
          summary: 'Default server',
          uri: serverUri,
          inboxUri: `${serverUri}/inbox`,
          outboxUri: `${serverUri}/outbox`,
          followersUri: `${serverUri}/followers`,
          followingUri: `${serverUri}/following`,
          local: true,
          // The default server is the one everyone lands in: public.
          // (Servers are invite-only unless marked public.)
          properties: { public: true },
        })
        .returning();
    }

    await ensureDefaultRoles(db, server.id);

    // Upsert the default "general" channel, attached to the server
    const [existingChannel] = await db
      .select()
      .from(objects)
      .where(eq(objects.uri, channelUri))
      .limit(1);

    if (existingChannel) {
      // Migrate: ensure it belongs to the server
      if (!existingChannel.belongsTo) {
        await db
          .update(objects)
          .set({ belongsTo: server.id })
          .where(eq(objects.id, existingChannel.id));
      }
    } else {
      await db.insert(objects).values({
        uri: channelUri,
        type: 'OrderedCollection',
        belongsTo: server.id,
        properties: { name: 'general' },
      });
    }

    fastify.log.info('Default server and channel seeded');
  });
}

export default fp(seedPlugin, {
  name: 'seed',
  dependencies: ['db'],
});
