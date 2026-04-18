// SPDX-License-Identifier: Hippocratic-3.0
import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import { eq, and, ne } from 'drizzle-orm';
import { pushSubscriptions } from './db/schema/push-subscriptions.ts';
import { notificationPreferences } from './db/schema/notification-preferences.ts';
import { actors } from './db/schema/actors.ts';

/**
 * Check if an actor is currently in DND mode (explicit or quiet hours).
 */
async function isActorDnd(
  db: FastifyInstance['db'],
  actorId: string,
): Promise<boolean> {
  const [actor] = await db
    .select({ properties: actors.properties })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!actor) return false;
  const props = actor.properties as Record<string, unknown> | null;
  if (!props) return false;

  // Explicit DND toggle
  if (props.dnd === true) return true;

  // Quiet hours: { enabled, startHour, endHour } (24h format, local time)
  const qh = props.quietHours as { enabled?: boolean; startHour?: number; endHour?: number } | undefined;
  if (qh?.enabled && typeof qh.startHour === 'number' && typeof qh.endHour === 'number') {
    const hour = new Date().getHours();
    if (qh.startHour > qh.endHour) {
      // Overnight range (e.g. 22-8)
      if (hour >= qh.startHour || hour < qh.endHour) return true;
    } else {
      if (hour >= qh.startHour && hour < qh.endHour) return true;
    }
  }

  return false;
}

let vapidConfigured = false;

export function initPush(fastify: FastifyInstance): void {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || `mailto:noreply@${fastify.config.domain}`;

  if (!publicKey || !privateKey) {
    fastify.log.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled');
    return;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  fastify.log.info('Web push configured');
}

export function isPushEnabled(): boolean {
  return vapidConfigured;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export async function sendPushToActor(
  fastify: FastifyInstance,
  actorId: string,
  channelId: string | null,
  payload: PushPayload,
): Promise<void> {
  if (!vapidConfigured) return;
  const db = fastify.db;

  // Check DND
  if (await isActorDnd(db, actorId)) return;

  // Check if this channel is muted for this actor
  if (channelId) {
    const [muted] = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.actorId, actorId),
          eq(notificationPreferences.targetId, channelId),
          eq(notificationPreferences.muted, true),
        ),
      )
      .limit(1);
    if (muted) return;
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.actorId, actorId));

  const body = JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404 or 410 = subscription expired, clean up
      if (status === 404 || status === 410) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, sub.id));
      } else {
        fastify.log.error({ err, endpoint: sub.endpoint }, 'Push delivery failed');
      }
    }
  }
}

/**
 * Send push to all members of a channel EXCEPT the sender.
 * Used for new messages and mentions.
 */
export async function broadcastPushToChannel(
  fastify: FastifyInstance,
  channelId: string,
  senderActorId: string,
  payload: PushPayload,
): Promise<void> {
  if (!vapidConfigured) return;
  const db = fastify.db;

  // Get all actors who have push subscriptions (except sender)
  const allSubs = await db
    .select()
    .from(pushSubscriptions)
    .where(ne(pushSubscriptions.actorId, senderActorId));

  // Group by actor, skip muted
  const actorSubs = new Map<string, typeof allSubs>();
  for (const sub of allSubs) {
    const list = actorSubs.get(sub.actorId) ?? [];
    list.push(sub);
    actorSubs.set(sub.actorId, list);
  }

  for (const [actorId, subs] of actorSubs) {
    // Check DND (explicit or quiet hours)
    if (await isActorDnd(db, actorId)) continue;

    // Check mute
    const [muted] = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.actorId, actorId),
          eq(notificationPreferences.targetId, channelId),
          eq(notificationPreferences.muted, true),
        ),
      )
      .limit(1);
    if (muted) continue;

    const body = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        }
      }
    }
  }
}
