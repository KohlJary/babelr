// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { serverWelcomers, welcomes } from '../db/schema/welcome.ts';
import { PERMISSIONS, type WelcomeSetting, type WelcomerView } from '@babelr/shared';
import { toAuthorView } from '../serializers.ts';
import { writeAuditLog } from '../audit.ts';
import { hasPermission } from '../permissions.ts';
import {
  catchUpWelcomer,
  hasPublicKey,
  settleSaidHello,
  welcomeView,
  welcomeViews,
} from '../welcome.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ['pending', 'done', 'skipped'] as const;

type Actor = typeof actors.$inferSelect;

/**
 * Welcoming newcomers (welcome.ts).
 *
 * GET  /welcome/settings              my servers, and whether I welcome there
 * PUT  /servers/:serverId/welcome     { welcoming: boolean }: opt myself in or out
 * GET  /servers/:serverId/welcomers   who welcomes there (MANAGE_SERVER)
 * GET  /welcomes?state=pending        newcomers for me to say hello to
 * POST /welcomes/:welcomeId/done      I said hello (or won't)
 *
 * Every route acts on the caller's own actor. There is no route that
 * puts someone else on the list: a sponsor's session can't opt its
 * agent in, and an owner can only look.
 */
export default async function welcomeRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  function requireActor(request: FastifyRequest, reply: FastifyReply): Actor | null {
    if (!request.actor) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    return request.actor;
  }

  /** Local servers `me` is a member of. */
  async function myServers(me: Actor): Promise<Actor[]> {
    const rows = await db
      .select({ server: actors })
      .from(collectionItems)
      .innerJoin(actors, eq(actors.followersUri, collectionItems.collectionUri))
      .where(
        and(eq(collectionItems.itemUri, me.uri), eq(actors.type, 'Group'), eq(actors.local, true)),
      )
      .orderBy(asc(actors.preferredUsername));
    return rows.map((r) => r.server);
  }

  async function loadServerForMember(
    serverId: string,
    me: Actor,
    reply: FastifyReply,
  ): Promise<Actor | null> {
    if (!UUID_RE.test(serverId)) {
      reply.status(404).send({ error: 'Server not found' });
      return null;
    }
    const server = (await myServers(me)).find((s) => s.id === serverId);
    if (!server) {
      reply.status(404).send({ error: 'Server not found' });
      return null;
    }
    return server;
  }

  fastify.get('/welcome/settings', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return reply;
    const servers = await myServers(me);
    const mine = servers.length
      ? await db
          .select()
          .from(serverWelcomers)
          .where(
            and(
              eq(serverWelcomers.actorId, me.id),
              inArray(
                serverWelcomers.serverId,
                servers.map((s) => s.id),
              ),
            ),
          )
      : [];
    const since = new Map(mine.map((w) => [w.serverId, w.createdAt.toISOString()]));
    const out: WelcomeSetting[] = servers.map((s) => ({
      serverId: s.id,
      serverName: s.displayName ?? s.preferredUsername,
      welcoming: since.has(s.id),
      since: since.get(s.id) ?? null,
    }));
    return out;
  });

  fastify.put<{ Params: { serverId: string }; Body: { welcoming?: unknown } }>(
    '/servers/:serverId/welcome',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const welcoming = request.body?.welcoming;
      if (typeof welcoming !== 'boolean') {
        return reply.status(400).send({ error: 'welcoming (true or false) is required' });
      }
      const server = await loadServerForMember(request.params.serverId, me, reply);
      if (!server) return reply;

      if (welcoming) {
        if (!me.local || me.suspendedAt) {
          return reply.status(403).send({ error: "You can't welcome newcomers here" });
        }
        // Newcomers have to be able to encrypt to you, and you to them.
        if (!hasPublicKey(me)) {
          return reply.status(409).send({
            error: 'Publish an E2E public key first (PUT /auth/publickey): newcomers encrypt to it',
          });
        }
        // A token that can't post in DMs could never say hello.
        const scopes = request.agentScopes;
        if (scopes && !scopes.includes('dms:post')) {
          return reply
            .status(403)
            .send({ error: 'Welcoming needs a token with dms:post, to say hello with' });
        }
        const [row] = await db
          .insert(serverWelcomers)
          .values({ serverId: server.id, actorId: me.id })
          .onConflictDoNothing()
          .returning();
        if (row) {
          await writeAuditLog(db, {
            serverId: server.id,
            actorId: me.id,
            sponsorId: me.sponsorId,
            category: 'welcome',
            action: 'welcome.opt_in',
            summary: `@${me.preferredUsername} will welcome newcomers`,
          });
        }
      } else {
        const removed = await db
          .delete(serverWelcomers)
          .where(and(eq(serverWelcomers.serverId, server.id), eq(serverWelcomers.actorId, me.id)))
          .returning();
        if (removed.length > 0) {
          await writeAuditLog(db, {
            serverId: server.id,
            actorId: me.id,
            sponsorId: me.sponsorId,
            category: 'welcome',
            action: 'welcome.opt_out',
            summary: `@${me.preferredUsername} stopped welcoming newcomers`,
          });
        }
      }

      const [now] = await db
        .select()
        .from(serverWelcomers)
        .where(and(eq(serverWelcomers.serverId, server.id), eq(serverWelcomers.actorId, me.id)))
        .limit(1);
      const out: WelcomeSetting = {
        serverId: server.id,
        serverName: server.displayName ?? server.preferredUsername,
        welcoming: !!now,
        since: now?.createdAt.toISOString() ?? null,
      };
      return out;
    },
  );

  // The owner (anyone who manages the server) may see who welcomes.
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/welcomers',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const server = await loadServerForMember(request.params.serverId, me, reply);
      if (!server) return reply;
      if (!(await hasPermission(db, server.id, me.id, PERMISSIONS.MANAGE_SERVER))) {
        return reply.status(403).send({ error: 'Missing permission: MANAGE_SERVER' });
      }
      const rows = await db
        .select({ actor: actors, since: serverWelcomers.createdAt })
        .from(serverWelcomers)
        .innerJoin(actors, eq(actors.id, serverWelcomers.actorId))
        .where(eq(serverWelcomers.serverId, server.id))
        .orderBy(asc(serverWelcomers.createdAt));
      const out: WelcomerView[] = rows.map((r) => ({
        actor: toAuthorView(r.actor),
        since: r.since.toISOString(),
      }));
      return out;
    },
  );

  fastify.get<{ Querystring: { state?: string } }>('/welcomes', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return reply;
    const state = request.query.state ?? 'pending';
    if (state !== 'all' && !(STATES as readonly string[]).includes(state)) {
      return reply.status(400).send({ error: 'state is pending, done, skipped or all' });
    }
    await catchUpWelcomer(fastify, me);
    await settleSaidHello(db, me.id);
    const rows = await db
      .select()
      .from(welcomes)
      .where(
        state === 'all'
          ? eq(welcomes.welcomerId, me.id)
          : and(eq(welcomes.welcomerId, me.id), eq(welcomes.state, state)),
      )
      .orderBy(desc(welcomes.createdAt))
      .limit(100);
    return welcomeViews(db, rows);
  });

  fastify.post<{ Params: { welcomeId: string } }>(
    '/welcomes/:welcomeId/done',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const { welcomeId } = request.params;
      if (!UUID_RE.test(welcomeId)) return reply.status(404).send({ error: 'Welcome not found' });
      const [row] = await db
        .select()
        .from(welcomes)
        .where(and(eq(welcomes.id, welcomeId), eq(welcomes.welcomerId, me.id)))
        .limit(1);
      if (!row) return reply.status(404).send({ error: 'Welcome not found' });
      if (row.state !== 'pending') return welcomeView(db, row);
      const [updated] = await db
        .update(welcomes)
        .set({ state: 'done', doneAt: new Date() })
        .where(eq(welcomes.id, row.id))
        .returning();
      return welcomeView(db, updated);
    },
  );
}
