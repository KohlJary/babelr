// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { activities } from '../db/schema/activities.ts';
import { agentTokens } from '../db/schema/agent-tokens.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { serverBans } from '../db/schema/bans.ts';
import { serverAgentGrants } from '../db/schema/server-agent-grants.ts';
import { PERMISSIONS } from '@babelr/shared';
import type { ServerAgentView, ServerAgentsResponse } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { writeAuditLog } from '../audit.ts';
import { isSponsoredKind } from '../actor-kind.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = typeof actors.$inferSelect;

/**
 * "Add a little guy": how agents and services get into a server.
 *
 * A person who is a member of the server and holds CREATE_INVITES picks
 * an agent and adds it. That writes a grant, joins the agent, and adds
 * `servers:join:<serverId>` to the agent's live tokens. Leaving (any
 * token may) or being kicked gives up both, so coming back takes a
 * member adding it again. A human on the
 * server's side is always in the loop; nobody can add an agent to a
 * server they don't belong to. Every add is audited with the inviter,
 * the agent and its sponsor. Kicking the agent deletes the grant.
 *
 * Person sessions only: these routes aren't in the agent scope map, so
 * an agent can't add itself or another agent.
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

      const scope = `servers:join:${server.id}`;
      const protocol = fastify.config.secureCookies ? 'https' : 'http';
      await db.transaction(async (tx) => {
        await tx
          .insert(serverAgentGrants)
          .values({ serverId: server.id, agentId: agent.id, invitedBy: me.id })
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
}
