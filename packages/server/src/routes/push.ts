// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import '../types.ts';
import { pushSubscriptions } from '../db/schema/push-subscriptions.ts';
import { getVapidPublicKey } from '../push.ts';

export default async function pushRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // Get VAPID public key so the client can create push subscriptions
  fastify.get('/push/vapid-key', async () => {
    const key = getVapidPublicKey();
    if (!key) return { enabled: false, key: null };
    return { enabled: true, key };
  });

  // Subscribe to push notifications
  fastify.post<{
    Body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
  }>('/push/subscribe', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { endpoint, keys } = request.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.status(400).send({ error: 'Invalid subscription' });
    }

    // Upsert — same endpoint replaces existing subscription
    const [existing] = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);

    if (existing) {
      await db
        .update(pushSubscriptions)
        .set({
          actorId: request.actor.id,
          p256dh: keys.p256dh,
          auth: keys.auth,
        })
        .where(eq(pushSubscriptions.id, existing.id));
    } else {
      await db.insert(pushSubscriptions).values({
        actorId: request.actor.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });
    }

    return { ok: true };
  });

  // Unsubscribe from push notifications
  fastify.delete<{
    Body: { endpoint: string };
  }>('/push/unsubscribe', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { endpoint } = request.body ?? {};
    if (!endpoint) {
      return reply.status(400).send({ error: 'Endpoint is required' });
    }

    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.actorId, request.actor.id),
        ),
      );

    return { ok: true };
  });
}
