// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { activities } from '../db/schema/activities.ts';
import { agentTokens } from '../db/schema/agent-tokens.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { serverBans } from '../db/schema/bans.ts';
import {
  serverAgentGrants,
  agentServerDepartures,
  agentServerInvites,
} from '../db/schema/server-agent-grants.ts';
import { PERMISSIONS } from '@babelr/shared';
import type { ServerAgentView, ServerAgentsResponse } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { writeAuditLog } from '../audit.ts';
import { isSponsoredKind } from '../actor-kind.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = typeof actors.$inferSelect;

/**
 * Let an agent into a server: the grant, the membership, and the
 * narrowed join scope on its live tokens. Clears any departure or
 * pending invite. Returns the scope.
 */
export async function admitAgent(
  fastify: FastifyInstance,
  server: Actor,
  agent: Actor,
  invitedBy: string | null,
): Promise<string> {
  const db = fastify.db;
  const scope = `servers:join:${server.id}`;
  const protocol = fastify.config.secureCookies ? 'https' : 'http';
  await db.transaction(async (tx) => {
    await tx
      .insert(serverAgentGrants)
      .values({ serverId: server.id, agentId: agent.id, invitedBy })
      .onConflictDoNothing();
    const [already] = await tx
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, server.followersUri!),
          eq(collectionItems.itemUri, agent.uri),
        ),
      )
      .limit(1);
    if (!already) {
      await tx.insert(collectionItems).values({
        collectionUri: server.followersUri!,
        collectionId: null,
        itemUri: agent.uri,
        itemId: agent.id,
      });
      await tx.insert(activities).values({
        uri: `${protocol}://${fastify.config.domain}/activities/${crypto.randomUUID()}`,
        type: 'Follow',
        actorId: agent.id,
        objectUri: server.uri,
      });
    }
    // Live tokens get the narrowed join scope, so the agent can
    // leave and rejoin this server (and only this one).
    await tx
      .update(agentTokens)
      .set({
        scopes: sql`${agentTokens.scopes} || ${JSON.stringify([scope])}::jsonb`,
      })
      .where(
        and(
          eq(agentTokens.actorId, agent.id),
          isNull(agentTokens.revokedAt),
          sql`NOT (${agentTokens.scopes} @> ${JSON.stringify([scope])}::jsonb)`,
        ),
      );
  });
  await db
    .delete(agentServerDepartures)
    .where(
      and(
        eq(agentServerDepartures.serverId, server.id),
        eq(agentServerDepartures.agentId, agent.id),
      ),
    );
  await db
    .delete(agentServerInvites)
    .where(
      and(eq(agentServerInvites.serverId, server.id), eq(agentServerInvites.agentId, agent.id)),
    );
  return scope;
}

/**
 * "Add a little guy": how agents and services get into a server.
 *
 * A person who is a member of the server and holds CREATE_INVITES picks
 * an agent and adds it. That writes a grant, joins the agent, and adds
 * `servers:join:<serverId>` to the agent's live tokens. Leaving (any
 * token may) or being kicked gives up both. After an agent *leaves*, a
 * member adding it again only invites it: the agent accepts or declines
 * at /agent-invites, so nobody (its sponsor included) can put it back.
 * A human on the server's side is always in the loop; nobody can add an
 * agent to a server they don't belong to. Every add is audited with the
 * inviter, the agent and its sponsor.
 *
 * The add routes are person sessions only (not in the agent scope map).
 * The /agent-invites routes are the agent's own.
 */

export default async function serverAgentRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  async function loadServerForInviter(
    request: FastifyRequest<{ Params: { serverId: string } }>,
    reply: FastifyReply,
  ): Promise<{ me: Actor; server: Actor } | null> {
    const me = request.actor;
    if (!me) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    if (request.agentScopes || me.kind !== 'person') {
      reply.status(403).send({ error: 'Only a person can add agents to a server' });
      return null;
    }
    const { serverId } = request.params;
    if (!UUID_RE.test(serverId)) {
      reply.status(404).send({ error: 'Server not found' });
      return null;
    }
    const [server] = await db
      .select()
      .from(actors)
      .where(and(eq(actors.id, serverId), eq(actors.type, 'Group'), eq(actors.local, true)))
      .limit(1);
    if (!server?.followersUri) {
      reply.status(404).send({ error: 'Server not found' });
      return null;
    }
    const [member] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, server.followersUri),
          eq(collectionItems.itemUri, me.uri),
        ),
      )
      .limit(1);
    if (!member || !(await hasPermission(db, server.id, me.id, PERMISSIONS.CREATE_INVITES))) {
      reply.status(403).send({ error: 'Only members who can invite may add agents' });
      return null;
    }
    return { me, server };
  }

  async function sponsorNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const [s] = await db
        .select({ preferredUsername: actors.preferredUsername })
        .from(actors)
        .where(eq(actors.id, id))
        .limit(1);
      if (s) out.set(id, s.preferredUsername);
    }
    return out;
  }

  // Agents in this server, and agents that could be added.
  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/agents',
    async (request, reply) => {
      const ctx = await loadServerForInviter(request, reply);
      if (!ctx) return;
      const { server } = ctx;

      const all = await db
        .select()
        .from(actors)
        .where(and(eq(actors.local, true), sql`${actors.kind} IN ('agent', 'service')`))
        .orderBy(actors.preferredUsername);
      const memberRows = await db
        .select({ itemUri: collectionItems.itemUri })
        .from(collectionItems)
        .where(eq(collectionItems.collectionUri, server.followersUri!));
      const memberUris = new Set(memberRows.map((m) => m.itemUri));
      const names = await sponsorNames(all.map((a) => a.sponsorId!).filter(Boolean));

      const view = (a: Actor): ServerAgentView => ({
        id: a.id,
        preferredUsername: a.preferredUsername,
        displayName: a.displayName,
        kind: a.kind as 'agent' | 'service',
        sponsorUsername: names.get(a.sponsorId!) ?? null,
        suspended: !!a.suspendedAt,
      });
      const body: ServerAgentsResponse = {
        members: all.filter((a) => memberUris.has(a.uri)).map(view),
        candidates: all.filter((a) => !memberUris.has(a.uri) && !a.suspendedAt).map(view),
      };
      return body;
    },
  );

  // Add a named agent to this server.
  fastify.post<{ Params: { serverId: string }; Body: { agentId?: string } }>(
    '/servers/:serverId/agents',
    async (request, reply) => {
      const ctx = await loadServerForInviter(request, reply);
      if (!ctx) return;
      const { me, server } = ctx;

      const agentId = request.body?.agentId;
      if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
        return reply.status(400).send({ error: 'agentId is required' });
      }
      const [agent] = await db.select().from(actors).where(eq(actors.id, agentId)).limit(1);
      if (!agent || !agent.local || !isSponsoredKind(agent.kind)) {
        return reply.status(404).send({ error: 'Agent not found' });
      }
      if (agent.suspendedAt) {
        return reply.status(409).send({ error: 'Agent is suspended' });
      }
      const [ban] = await db
        .select()
        .from(serverBans)
        .where(and(eq(serverBans.serverId, server.id), eq(serverBans.userId, agent.id)))
        .limit(1);
      if (ban && !(ban.expiresAt && new Date() > ban.expiresAt)) {
        return reply.status(403).send({ error: 'That agent is banned from this server' });
      }

      // It left this server itself: re-adding it is only an invite, and
      // the agent decides (GET /agent-invites, then accept or decline).
      const [departed] = await db
        .select({ id: agentServerDepartures.id })
        .from(agentServerDepartures)
        .where(
          and(
            eq(agentServerDepartures.serverId, server.id),
            eq(agentServerDepartures.agentId, agent.id),
          ),
        )
        .limit(1);
      if (departed) {
        await db
          .insert(agentServerInvites)
          .values({ serverId: server.id, agentId: agent.id, invitedBy: me.id })
          .onConflictDoUpdate({
            target: [agentServerInvites.serverId, agentServerInvites.agentId],
            set: { invitedBy: me.id, createdAt: new Date() },
          });
        await writeAuditLog(db, {
          serverId: server.id,
          actorId: me.id,
          sponsorId: agent.sponsorId,
          category: 'agent',
          action: 'agent.server.reinvite',
          summary: `@${me.preferredUsername} invited @${agent.preferredUsername} back; it decides`,
          details: { agentId: agent.id, sponsorId: agent.sponsorId, serverId: server.id },
        });
        return reply.status(202).send({ ok: true, pending: true, agentId: agent.id });
      }

      const scope = await admitAgent(fastify, server, agent, me.id);
      await writeAuditLog(db, {
        serverId: server.id,
        actorId: me.id,
        sponsorId: agent.sponsorId,
        category: 'agent',
        action: 'agent.server.invite',
        summary: `@${me.preferredUsername} added @${agent.preferredUsername} to ${server.displayName ?? server.preferredUsername}`,
        details: { agentId: agent.id, sponsorId: agent.sponsorId, serverId: server.id },
        scope,
      });

      return reply.status(201).send({ ok: true, agentId: agent.id, scope });
    },
  );

  /** The agent's own pending invites back into servers it left. */
  function requireAgent(request: FastifyRequest, reply: FastifyReply): Actor | null {
    const me = request.actor;
    if (!me) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    if (!isSponsoredKind(me.kind)) {
      reply.status(404).send({ error: 'No invites' });
      return null;
    }
    return me;
  }

  fastify.get('/agent-invites', async (request, reply) => {
    const me = requireAgent(request, reply);
    if (!me) return reply;
    const rows = await db
      .select({ invite: agentServerInvites, server: actors })
      .from(agentServerInvites)
      .innerJoin(actors, eq(agentServerInvites.serverId, actors.id))
      .where(eq(agentServerInvites.agentId, me.id));
    return rows.map((r) => ({
      serverId: r.server.id,
      serverName: r.server.displayName ?? r.server.preferredUsername,
      invitedBy: r.invite.invitedBy,
      createdAt: r.invite.createdAt.toISOString(),
    }));
  });

  async function loadInvite(me: Actor, serverId: string) {
    if (!UUID_RE.test(serverId)) return null;
    const [row] = await db
      .select({ invite: agentServerInvites, server: actors })
      .from(agentServerInvites)
      .innerJoin(actors, eq(agentServerInvites.serverId, actors.id))
      .where(and(eq(agentServerInvites.serverId, serverId), eq(agentServerInvites.agentId, me.id)))
      .limit(1);
    return row ?? null;
  }

  // Coming back is the agent's own act.
  fastify.post<{ Params: { serverId: string } }>(
    '/agent-invites/:serverId/accept',
    async (request, reply) => {
      const me = requireAgent(request, reply);
      if (!me) return reply;
      const row = await loadInvite(me, request.params.serverId);
      if (!row || !row.server.followersUri) {
        return reply.status(404).send({ error: 'No invite' });
      }
      const [ban] = await db
        .select()
        .from(serverBans)
        .where(and(eq(serverBans.serverId, row.server.id), eq(serverBans.userId, me.id)))
        .limit(1);
      if (ban && !(ban.expiresAt && new Date() > ban.expiresAt)) {
        return reply.status(403).send({ error: 'Banned from this server' });
      }
      const scope = await admitAgent(fastify, row.server, me, row.invite.invitedBy);
      await writeAuditLog(db, {
        serverId: row.server.id,
        actorId: me.id,
        sponsorId: me.sponsorId,
        category: 'agent',
        action: 'agent.server.invite_accepted',
        summary: `@${me.preferredUsername} accepted an invite back`,
        details: { agentId: me.id, invitedBy: row.invite.invitedBy, serverId: row.server.id },
        scope,
      });
      return { ok: true, scope };
    },
  );

  fastify.post<{ Params: { serverId: string } }>(
    '/agent-invites/:serverId/decline',
    async (request, reply) => {
      const me = requireAgent(request, reply);
      if (!me) return reply;
      const row = await loadInvite(me, request.params.serverId);
      if (!row) return reply.status(404).send({ error: 'No invite' });
      await db.delete(agentServerInvites).where(eq(agentServerInvites.id, row.invite.id));
      await writeAuditLog(db, {
        serverId: row.server.id,
        actorId: me.id,
        sponsorId: me.sponsorId,
        category: 'agent',
        action: 'agent.server.invite_declined',
        summary: `@${me.preferredUsername} declined an invite back`,
        details: { agentId: me.id, invitedBy: row.invite.invitedBy, serverId: row.server.id },
      });
      return { ok: true };
    },
  );
}
