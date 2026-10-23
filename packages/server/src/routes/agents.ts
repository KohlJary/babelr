// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, or, desc, lt, isNull, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { agentTokens } from '../db/schema/agent-tokens.ts';
import { auditLogs } from '../db/schema/audit-logs.ts';
import { writeAuditLog } from '../audit.ts';
import { objects } from '../db/schema/objects.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { serverAgentGrants } from '../db/schema/server-agent-grants.ts';
import { checkChannelAccess } from '../serializers.ts';
import { hasPermission } from '../permissions.ts';
import { PERMISSIONS } from '@babelr/shared';
import { as2TypeForKind, isSponsoredKind } from '../actor-kind.ts';
import { isValidScope } from '../agent-scopes.ts';
import {
  formatToken,
  hashSecret,
  isInstanceAdmin,
  newTokenSecret,
  suspendAgent,
} from '../agent-tokens.ts';
import type {
  AgentView,
  AgentTokenView,
  CreateAgentInput,
  CreateAgentTokenInput,
  CreatedAgentToken,
  AuditLogEntry,
} from '@babelr/shared';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCOPES = 32;
const MAX_TOKEN_DAYS = 3650;

type Actor = typeof actors.$inferSelect;
type TokenRow = typeof agentTokens.$inferSelect;

function toTokenView(t: TokenRow): AgentTokenView {
  return {
    id: t.id,
    name: t.name,
    scopes: (t.scopes as string[]) ?? [],
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Agent and service accounts, managed by their sponsor.
 *
 * Every route here needs a person's browser session. None is in the
 * agent scope map, so an agent token gets 403 from the auth hook
 * before reaching them: an agent can't mint, list or revoke tokens,
 * suspend anyone, or read the audit log, its own included.
 *
 * Minting, listing and revoking tokens is the sponsor's alone. The
 * kill switch and the audit log are the sponsor's or an instance
 * admin's.
 */
export default async function agentRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  /** The calling person, or a reply already sent. */
  function requirePerson(request: FastifyRequest, reply: FastifyReply): Actor | null {
    const me = request.actor;
    if (!me) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    if (request.agentScopes || me.kind !== 'person' || !me.local) {
      reply.status(403).send({ error: 'Only a person can manage agents' });
      return null;
    }
    return me;
  }

  async function activeTokenCount(agentId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.actorId, agentId),
          isNull(agentTokens.revokedAt),
          sql`(${agentTokens.expiresAt} IS NULL OR ${agentTokens.expiresAt} > now())`,
        ),
      );
    return row?.n ?? 0;
  }

  async function toAgentView(a: Actor): Promise<AgentView> {
    return {
      id: a.id,
      preferredUsername: a.preferredUsername,
      displayName: a.displayName,
      kind: a.kind as 'agent' | 'service',
      sponsorId: a.sponsorId!,
      suspendedAt: a.suspendedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      activeTokens: await activeTokenCount(a.id),
    };
  }

  /**
   * Load the agent and check the caller's authority over it.
   * `sponsorOnly` for token management; otherwise admins may too.
   */
  async function loadAgent(
    request: FastifyRequest<{ Params: { agentId: string } }>,
    reply: FastifyReply,
    sponsorOnly: boolean,
  ): Promise<{ me: Actor; agent: Actor } | null> {
    const me = requirePerson(request, reply);
    if (!me) return null;
    const { agentId } = request.params;
    if (!UUID_RE.test(agentId)) {
      reply.status(404).send({ error: 'Agent not found' });
      return null;
    }
    const [agent] = await db.select().from(actors).where(eq(actors.id, agentId)).limit(1);
    if (!agent || !isSponsoredKind(agent.kind) || !agent.local) {
      reply.status(404).send({ error: 'Agent not found' });
      return null;
    }
    const isSponsor = agent.sponsorId === me.id;
    if (!isSponsor && (sponsorOnly || !isInstanceAdmin(me))) {
      // 404, not 403: don't confirm someone else's agent exists.
      reply.status(404).send({ error: 'Agent not found' });
      return null;
    }
    return { me, agent };
  }

  /**
   * A sponsor can't grant more than they could do themselves. Bare
   * scopes name kinds of action, and the routes still check the agent's
   * own membership, so the cap applies to the resources a narrowed
   * scope names:
   *   channels:read:<id> / channels:post:<id>: a server channel the
   *     sponsor can read (and, for post, send to);
   *   servers:join:<id>: a server a member has let this agent into;
   *   dms:read:<id> / dms:post:<id>: a DM the agent is already in. The
   *     sponsor needn't be in it: an agent's private rooms stay private.
   */
  async function scopesBeyondSponsor(me: Actor, agent: Actor, scopes: string[]) {
    const beyond: string[] = [];
    for (const scope of scopes) {
      const i = scope.lastIndexOf(':');
      const base = scope.slice(0, i);
      const id = scope.slice(i + 1);
      if (base === 'channels:read' || base === 'channels:post') {
        const { allowed, channel } = await checkChannelAccess(db, id, me.uri);
        let ok = allowed && !!channel?.belongsTo;
        if (ok && base === 'channels:post') {
          ok = await hasPermission(db, channel!.belongsTo!, me.id, PERMISSIONS.SEND_MESSAGES);
        }
        if (!ok) beyond.push(scope);
      } else if (base === 'servers:join') {
        // Only for a server a member has let this agent into
        // (POST /servers/:id/agents). Being a member yourself isn't
        // enough: someone with invite rights on the server's side
        // decides.
        const [grant] = await db
          .select({ id: serverAgentGrants.id })
          .from(serverAgentGrants)
          .where(and(eq(serverAgentGrants.serverId, id), eq(serverAgentGrants.agentId, agent.id)))
          .limit(1);
        if (!grant) beyond.push(scope);
      } else if (base === 'dms:read' || base === 'dms:post') {
        const [dm] = await db
          .select({ uri: objects.uri })
          .from(objects)
          .where(and(eq(objects.id, id), isNull(objects.belongsTo)))
          .limit(1);
        const [participant] = dm
          ? await db
              .select({ id: collectionItems.id })
              .from(collectionItems)
              .where(
                and(
                  eq(collectionItems.collectionUri, dm.uri),
                  eq(collectionItems.itemUri, agent.uri),
                ),
              )
              .limit(1)
          : [];
        if (!participant) beyond.push(scope);
      }
    }
    return beyond;
  }

  function audit(me: Actor, agent: Actor, action: string, summary: string, details = {}) {
    return writeAuditLog(db, {
      serverId: null,
      actorId: me.id,
      sponsorId: agent.sponsorId,
      category: 'agent',
      action,
      summary,
      details: { agentId: agent.id, ...details },
    });
  }

  // Create an agent or service; the caller becomes its sponsor.
  fastify.post<{ Body: CreateAgentInput }>('/agents', async (request, reply) => {
    const me = requirePerson(request, reply);
    if (!me) return;
    if (me.suspendedAt) return reply.status(403).send({ error: 'Account suspended' });

    const { username, displayName, kind } = request.body ?? ({} as CreateAgentInput);
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return reply.status(400).send({
        error: 'Username must be 3-32 characters, alphanumeric and underscores only',
      });
    }
    if (kind !== 'agent' && kind !== 'service') {
      return reply.status(400).send({ error: "kind must be 'agent' or 'service'" });
    }

    const [existing] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.preferredUsername, username), eq(actors.local, true)))
      .limit(1);
    if (existing) return reply.status(409).send({ error: 'Username already taken' });

    const protocol = fastify.config.secureCookies ? 'https' : 'http';
    const baseUri = `${protocol}://${fastify.config.domain}/users/${username}`;
    const [agent] = await db
      .insert(actors)
      .values({
        type: as2TypeForKind(kind),
        kind,
        sponsorId: me.id,
        preferredUsername: username,
        displayName:
          typeof displayName === 'string' && displayName.trim()
            ? displayName.trim().slice(0, 128)
            : null,
        // No email and no password: an agent can never log in.
        email: null,
        passwordHash: null,
        emailVerified: true,
        uri: baseUri,
        inboxUri: `${baseUri}/inbox`,
        outboxUri: `${baseUri}/outbox`,
        followersUri: `${baseUri}/followers`,
        followingUri: `${baseUri}/following`,
        local: true,
      })
      .returning();

    await audit(me, agent, 'agent.create', `Created ${kind} @${username}`, { kind });
    return reply.status(201).send(await toAgentView(agent));
  });

  // My agents. An admin may pass ?all=1 to see every agent.
  fastify.get<{ Querystring: { all?: string } }>('/agents', async (request, reply) => {
    const me = requirePerson(request, reply);
    if (!me) return;
    const all = request.query.all === '1' && isInstanceAdmin(me);
    const rows = await db
      .select()
      .from(actors)
      .where(
        and(
          eq(actors.local, true),
          sql`${actors.kind} IN ('agent', 'service')`,
          all ? undefined : eq(actors.sponsorId, me.id),
        ),
      )
      .orderBy(actors.preferredUsername);
    return Promise.all(rows.map(toAgentView));
  });

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId', async (request, reply) => {
    const ctx = await loadAgent(request, reply, false);
    if (!ctx) return;
    return toAgentView(ctx.agent);
  });

  // Mint a token. The secret is in this response and nowhere else.
  fastify.post<{ Params: { agentId: string }; Body: CreateAgentTokenInput }>(
    '/agents/:agentId/tokens',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, true);
      if (!ctx) return;
      const { me, agent } = ctx;
      if (agent.suspendedAt) {
        return reply.status(409).send({ error: 'Agent is suspended; unsuspend it first' });
      }

      const { name, scopes, expiresInDays } = request.body ?? ({} as CreateAgentTokenInput);
      if (typeof name !== 'string' || !name.trim() || name.length > 64) {
        return reply.status(400).send({ error: 'name is required (max 64 characters)' });
      }
      if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES) {
        return reply.status(400).send({ error: 'scopes must be an array' });
      }
      const bad = scopes.filter((s) => !isValidScope(s));
      if (bad.length > 0) {
        return reply.status(400).send({ error: 'Unknown scopes', scopes: bad });
      }
      const beyond = await scopesBeyondSponsor(me, agent, scopes);
      if (beyond.length > 0) {
        return reply
          .status(403)
          .send({ error: 'Scopes go beyond what the sponsor can grant', scopes: beyond });
      }
      let expiresAt: Date | null = null;
      if (expiresInDays !== undefined) {
        if (
          typeof expiresInDays !== 'number' ||
          !Number.isFinite(expiresInDays) ||
          expiresInDays <= 0 ||
          expiresInDays > MAX_TOKEN_DAYS
        ) {
          return reply.status(400).send({ error: 'expiresInDays must be between 0 and 3650' });
        }
        expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
      }

      const secret = newTokenSecret();
      const [row] = await db
        .insert(agentTokens)
        .values({
          actorId: agent.id,
          createdBy: me.id,
          name: name.trim(),
          tokenHash: hashSecret(secret),
          scopes: [...new Set(scopes)],
          expiresAt,
        })
        .returning();

      await audit(me, agent, 'agent.token.create', `Minted token "${row.name}"`, {
        tokenId: row.id,
        scopes: row.scopes,
      });
      const body: CreatedAgentToken = { ...toTokenView(row), token: formatToken(row.id, secret) };
      return reply.status(201).send(body);
    },
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/tokens',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, true);
      if (!ctx) return;
      const rows = await db
        .select()
        .from(agentTokens)
        .where(eq(agentTokens.actorId, ctx.agent.id))
        .orderBy(desc(agentTokens.createdAt));
      return rows.map(toTokenView);
    },
  );

  fastify.delete<{ Params: { agentId: string; tokenId: string } }>(
    '/agents/:agentId/tokens/:tokenId',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, true);
      if (!ctx) return;
      if (!UUID_RE.test(request.params.tokenId)) {
        return reply.status(404).send({ error: 'Token not found' });
      }
      const [row] = await db
        .update(agentTokens)
        .set({ revokedAt: new Date(), revokedBy: ctx.me.id })
        .where(
          and(
            eq(agentTokens.id, request.params.tokenId),
            eq(agentTokens.actorId, ctx.agent.id),
            isNull(agentTokens.revokedAt),
          ),
        )
        .returning();
      if (!row) return reply.status(404).send({ error: 'Token not found or already revoked' });
      await audit(ctx.me, ctx.agent, 'agent.token.revoke', `Revoked token "${row.name}"`, {
        tokenId: row.id,
      });
      return toTokenView(row);
    },
  );

  // The kill switch: one call revokes every token, cancels pending
  // deliveries, and blocks posting.
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/suspend',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, false);
      if (!ctx) return;
      const result = await suspendAgent(db, ctx.agent, ctx.me.id);
      const [agent] = await db.select().from(actors).where(eq(actors.id, ctx.agent.id)).limit(1);
      await audit(ctx.me, agent, 'agent.suspend', `Suspended @${agent.preferredUsername}`, {
        ...result,
      });
      return { agent: await toAgentView(agent), ...result };
    },
  );

  // Lift a suspension. Tokens stay revoked; the sponsor mints new ones.
  // If an admin (not the sponsor) suspended it, only an admin can lift it.
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/unsuspend',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, false);
      if (!ctx) return;
      const { me, agent } = ctx;
      if (!agent.suspendedAt) return toAgentView(agent);
      if (
        agent.suspendedBy &&
        agent.suspendedBy !== agent.sponsorId &&
        agent.suspendedBy !== me.id &&
        !isInstanceAdmin(me)
      ) {
        return reply.status(403).send({ error: 'Suspended by an admin; ask an admin to lift it' });
      }
      const [updated] = await db
        .update(actors)
        .set({ suspendedAt: null, suspendedBy: null, updatedAt: new Date() })
        .where(eq(actors.id, agent.id))
        .returning();
      await audit(me, updated, 'agent.unsuspend', `Unsuspended @${updated.preferredUsername}`);
      return toAgentView(updated);
    },
  );

  // Admins only: requests with tokens that matched no agent (logged by
  // a hash prefix of the token, never the token).
  fastify.get('/agents/audit/unattributed', async (request, reply) => {
    const me = requirePerson(request, reply);
    if (!me) return;
    if (!isInstanceAdmin(me)) return reply.status(403).send({ error: 'Admins only' });
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.category, 'agent'), isNull(auditLogs.actorId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: r.summary,
      route: r.route,
      details: r.details ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  // Everything the agent did with a token, and everything done to it.
  fastify.get<{ Params: { agentId: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/agents/:agentId/audit',
    async (request, reply) => {
      const ctx = await loadAgent(request, reply, false);
      if (!ctx) return;
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
      const conditions = [
        eq(auditLogs.category, 'agent'),
        or(
          eq(auditLogs.actorId, ctx.agent.id),
          sql`${auditLogs.details}->>'agentId' = ${ctx.agent.id}`,
        ),
      ];
      if (request.query.cursor) {
        const c = new Date(request.query.cursor);
        if (!Number.isNaN(c.getTime())) conditions.push(lt(auditLogs.createdAt, c));
      }
      const rows = await db
        .select({ log: auditLogs, actor: actors })
        .from(auditLogs)
        .innerJoin(actors, eq(auditLogs.actorId, actors.id))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit + 1);
      const entries: AuditLogEntry[] = rows.slice(0, limit).map((r) => ({
        id: r.log.id,
        actorId: r.log.actorId ?? r.actor.id,
        actorName: r.actor.displayName ?? r.actor.preferredUsername,
        category: r.log.category,
        action: r.log.action,
        summary: r.log.summary,
        details: r.log.details ?? undefined,
        createdAt: r.log.createdAt.toISOString(),
        sponsorId: r.log.sponsorId,
        scope: r.log.scope,
        route: r.log.route,
      }));
      const hasMore = rows.length > limit;
      return {
        entries,
        hasMore,
        ...(hasMore && entries.length > 0 ? { cursor: entries[entries.length - 1].createdAt } : {}),
      };
    },
  );
}
