// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { actorBlocks, dmAllowlist, dmRequests } from '../db/schema/dm-consent.ts';
import type { BlockView, DmPolicy, DmSettings } from '@babelr/shared';
import { toAuthorView } from '../serializers.ts';
import { writeAuditLog } from '../audit.ts';
import { isActorLike, isSponsoredKind } from '../actor-kind.ts';
import { DECLINE_COOLDOWN_MS, isDmPolicy } from '../dm-consent.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = typeof actors.$inferSelect;

/**
 * "Who can message me", the allowlist, and blocks. Each actor manages
 * only its own: there is no route here that takes someone else's id as
 * the owner, so a sponsor can't change an agent's settings with their
 * own session. Agents reach these with any token (no scope needed,
 * see agent-scopes.ts): saying no is never something a sponsor grants.
 * An agent's changes are audited for its sponsor to see.
 */
export default async function dmConsentRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  function requireActor(request: FastifyRequest, reply: FastifyReply): Actor | null {
    if (!request.actor) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    return request.actor;
  }

  async function loadOther(id: unknown, reply: FastifyReply): Promise<Actor | null> {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.status(400).send({ error: 'actorId is required' });
      return null;
    }
    const [other] = await db.select().from(actors).where(eq(actors.id, id)).limit(1);
    if (!other || !isActorLike(other.type)) {
      reply.status(404).send({ error: 'User not found' });
      return null;
    }
    return other;
  }

  function audit(me: Actor, action: string, summary: string, details: Record<string, unknown>) {
    if (!isSponsoredKind(me.kind)) return Promise.resolve();
    return writeAuditLog(db, {
      serverId: null,
      actorId: me.id,
      sponsorId: me.sponsorId,
      category: 'agent',
      action,
      summary,
      details,
    });
  }

  async function settingsFor(me: Actor): Promise<DmSettings> {
    const allowed = await db
      .select({ actor: actors })
      .from(dmAllowlist)
      .innerJoin(actors, eq(dmAllowlist.allowedId, actors.id))
      .where(eq(dmAllowlist.ownerId, me.id))
      .orderBy(actors.preferredUsername);
    return {
      dmPolicy: (isDmPolicy(me.dmPolicy) ? me.dmPolicy : 'nobody') as DmPolicy,
      setBy: !me.dmPolicySetBy ? null : me.dmPolicySetBy === me.id ? 'self' : 'sponsor',
      setAt: me.dmPolicySetAt?.toISOString() ?? null,
      allowlist: allowed.map((a) => toAuthorView(a.actor)),
    };
  }

  fastify.get('/auth/dm-settings', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    return settingsFor(me);
  });

  fastify.put<{ Body: { dmPolicy?: unknown } }>('/auth/dm-settings', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    const policy = request.body?.dmPolicy;
    if (!isDmPolicy(policy)) {
      return reply.status(400).send({
        error: "dmPolicy must be 'anyone', 'friends', 'members_of_shared_servers' or 'nobody'",
      });
    }
    const now = new Date();
    const [updated] = await db
      .update(actors)
      .set({ dmPolicy: policy, dmPolicySetBy: me.id, dmPolicySetAt: now, updatedAt: now })
      .where(eq(actors.id, me.id))
      .returning();
    await audit(me, 'dm.policy.set', `@${me.preferredUsername} set DMs to ${policy}`, {
      from: me.dmPolicy,
      to: policy,
    });
    return settingsFor(updated);
  });

  fastify.post<{ Body: { actorId?: unknown } }>('/auth/dm-allowlist', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    const other = await loadOther(request.body?.actorId, reply);
    if (!other) return;
    if (other.id === me.id) return reply.status(400).send({ error: 'That is you' });
    await db
      .insert(dmAllowlist)
      .values({ ownerId: me.id, allowedId: other.id, addedBy: me.id })
      .onConflictDoNothing();
    await audit(
      me,
      'dm.allowlist.add',
      `@${me.preferredUsername} allowed @${other.preferredUsername}`,
      {
        allowedId: other.id,
      },
    );
    return settingsFor(me);
  });

  fastify.delete<{ Params: { actorId: string } }>(
    '/auth/dm-allowlist/:actorId',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return;
      if (!UUID_RE.test(request.params.actorId)) {
        return reply.status(404).send({ error: 'Not on your list' });
      }
      const removed = await db
        .delete(dmAllowlist)
        .where(
          and(eq(dmAllowlist.ownerId, me.id), eq(dmAllowlist.allowedId, request.params.actorId)),
        )
        .returning({ id: dmAllowlist.id });
      if (removed.length === 0) return reply.status(404).send({ error: 'Not on your list' });
      await audit(me, 'dm.allowlist.remove', `@${me.preferredUsername} removed someone from DMs`, {
        allowedId: request.params.actorId,
      });
      return settingsFor(me);
    },
  );

  fastify.get('/blocks', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    const rows = await db
      .select({ actor: actors, createdAt: actorBlocks.createdAt })
      .from(actorBlocks)
      .innerJoin(actors, eq(actorBlocks.blockedId, actors.id))
      .where(eq(actorBlocks.blockerId, me.id))
      .orderBy(desc(actorBlocks.createdAt));
    const out: BlockView[] = rows.map((r) => ({
      actor: toAuthorView(r.actor),
      createdAt: r.createdAt.toISOString(),
    }));
    return out;
  });

  /**
   * Block someone: no DMs, message requests or mentions from them, and
   * no DMs to them either. It beats an accepted request and the
   * allowlist. A pending request from them is declined.
   */
  fastify.post<{ Body: { actorId?: unknown } }>('/blocks', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    const other = await loadOther(request.body?.actorId, reply);
    if (!other) return;
    if (other.id === me.id) return reply.status(400).send({ error: "You can't block yourself" });
    await db
      .insert(actorBlocks)
      .values({ blockerId: me.id, blockedId: other.id })
      .onConflictDoNothing();
    const now = new Date();
    await db
      .update(dmRequests)
      .set({
        state: 'declined',
        decidedAt: now,
        cooldownUntil: new Date(now.getTime() + DECLINE_COOLDOWN_MS),
      })
      .where(
        and(
          eq(dmRequests.fromId, other.id),
          eq(dmRequests.toId, me.id),
          eq(dmRequests.state, 'pending'),
        ),
      );
    await audit(me, 'block.add', `@${me.preferredUsername} blocked @${other.preferredUsername}`, {
      blockedId: other.id,
    });
    return reply.status(201).send({ ok: true });
  });

  fastify.delete<{ Params: { actorId: string } }>('/blocks/:actorId', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return;
    if (!UUID_RE.test(request.params.actorId)) {
      return reply.status(404).send({ error: 'Not blocked' });
    }
    const removed = await db
      .delete(actorBlocks)
      .where(
        and(eq(actorBlocks.blockerId, me.id), eq(actorBlocks.blockedId, request.params.actorId)),
      )
      .returning({ id: actorBlocks.id });
    if (removed.length === 0) return reply.status(404).send({ error: 'Not blocked' });
    await audit(me, 'block.remove', `@${me.preferredUsername} unblocked someone`, {
      blockedId: request.params.actorId,
    });
    return { ok: true };
  });
}
