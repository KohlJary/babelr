// SPDX-License-Identifier: Hippocratic-3.0
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Database } from './db/index.ts';
import { actors } from './db/schema/actors.ts';
import { agentTokens } from './db/schema/agent-tokens.ts';
import { deliveryQueue } from './db/schema/delivery-queue.ts';

/** Tokens look like `bt_<uuid>_<64 hex chars>`. */
const TOKEN_RE =
  /^bt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{64})$/;

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newTokenSecret(): string {
  return randomBytes(32).toString('hex');
}

export function formatToken(id: string, secret: string): string {
  return `bt_${id}_${secret}`;
}

export function parseToken(raw: string): { id: string; secret: string } | null {
  const m = TOKEN_RE.exec(raw.trim());
  return m ? { id: m[1], secret: m[2] } : null;
}

/** Constant-time comparison of two hex sha256 digests. */
export function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Is this actor a local person who may act as an instance admin? */
export function isInstanceAdmin(actor: typeof actors.$inferSelect | undefined): boolean {
  if (!actor || actor.kind !== 'person' || !actor.local) return false;
  const props = actor.properties as Record<string, unknown> | null;
  return props?.instanceAdmin === true;
}

/**
 * The kill switch. In one transaction: mark the agent suspended,
 * revoke every live token, and cancel its federation deliveries that
 * haven't gone out yet (sent by it, or carrying its notes through a
 * server's Group). The auth hook refuses a suspended actor on the next
 * request, and createMessageInChannel refuses to post as one.
 */
export async function suspendAgent(
  db: Database,
  agent: typeof actors.$inferSelect,
  byActorId: string,
): Promise<{ revokedTokens: number; cancelledDeliveries: number }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(actors)
      .set({ suspendedAt: now, suspendedBy: byActorId, updatedAt: now })
      .where(eq(actors.id, agent.id));
    const revoked = await tx
      .update(agentTokens)
      .set({ revokedAt: now, revokedBy: byActorId })
      .where(and(eq(agentTokens.actorId, agent.id), isNull(agentTokens.revokedAt)))
      .returning({ id: agentTokens.id });
    const cancelled = await tx
      .update(deliveryQueue)
      .set({ status: 'cancelled', lastError: 'Sender suspended' })
      .where(
        and(
          eq(deliveryQueue.status, 'pending'),
          sql`(${deliveryQueue.senderActorId} = ${agent.id}
            OR ${deliveryQueue.activityJson}->>'actor' = ${agent.uri}
            OR ${deliveryQueue.activityJson}->'object'->>'attributedTo' = ${agent.uri})`,
        ),
      )
      .returning({ id: deliveryQueue.id });
    return { revokedTokens: revoked.length, cancelledDeliveries: cancelled.length };
  });
}

/**
 * For the delivery worker: does this activity speak for a suspended
 * local actor? Covers items queued after the kill switch by a path
 * that didn't go through the auth hook.
 */
export async function activityFromSuspendedActor(
  db: Database,
  activity: Record<string, unknown>,
): Promise<boolean> {
  const uris = new Set<string>();
  if (typeof activity.actor === 'string') uris.add(activity.actor);
  const obj = activity.object as Record<string, unknown> | undefined;
  if (obj && typeof obj === 'object' && typeof obj.attributedTo === 'string') {
    uris.add(obj.attributedTo);
  }
  for (const uri of uris) {
    const [row] = await db
      .select({ suspendedAt: actors.suspendedAt })
      .from(actors)
      .where(and(eq(actors.uri, uri), eq(actors.local, true)))
      .limit(1);
    if (row?.suspendedAt) return true;
  }
  return false;
}
