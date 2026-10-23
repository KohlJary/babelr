// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { and, eq, gt, gte, inArray, or, sql } from 'drizzle-orm';
import './types.ts';
import type { Database } from './db/index.ts';
import { actors } from './db/schema/actors.ts';
import { objects } from './db/schema/objects.ts';
import { collectionItems } from './db/schema/collections.ts';
import { friendships } from './db/schema/friendships.ts';
import { actorBlocks, dmAllowlist, dmDepartures, dmRequests } from './db/schema/dm-consent.ts';
import { DM_POLICIES, type DMConversation, type DmPolicy } from '@babelr/shared';
import { toAuthorView, toMessageView } from './serializers.ts';
import { writeAuditLog } from './audit.ts';
import { isSponsoredKind } from './actor-kind.ts';
import { serializeActivity } from './federation/jsonld.ts';
import { enqueueDelivery } from './federation/delivery.ts';
import { ensureActorKeys } from './federation/keys.ts';

/**
 * DM consent (Babelr step 3d). Chapter House's invariant, "nobody is
 * anyone's bitch": every member can say no, and every member can
 * leave. Here that means:
 *
 * - a DM policy per actor (`actors.dm_policy`) plus an allowlist;
 * - message requests: under `friends` or `members_of_shared_servers` a
 *   stranger's first message waits for the recipient to accept it;
 *   declining stops further requests for DECLINE_COOLDOWN_MS;
 * - blocks, which beat everything (an accepted request included);
 * - leaving, which only the leaver can undo.
 *
 * Refusals use one neutral message, so a 403 never says which rule
 * (policy, block, cooldown, departure) said no.
 */

type Actor = typeof actors.$inferSelect;
type DmRow = typeof objects.$inferSelect;
type Db = Database;

/** Declining a request blocks new requests from that sender this long. */
export const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Messages a requester may send before the request is answered. */
export const PENDING_MESSAGE_LIMIT = 1;

export const REFUSED_OPEN = "You can't message this person right now.";
export const REFUSED_POST = "You can't send messages in this conversation.";
export const REQUEST_WAITING = 'Your message request is waiting for an answer.';
export const EVERYONE_LEFT = 'Everyone else has left this conversation.';

export function isDmPolicy(v: unknown): v is DmPolicy {
  return typeof v === 'string' && (DM_POLICIES as readonly string[]).includes(v);
}

/** The policy an actor of this kind starts with. */
export function defaultDmPolicy(kind: string): DmPolicy {
  return isSponsoredKind(kind) ? 'nobody' : 'anyone';
}

export async function hasBlocked(db: Db, blockerId: string, blockedId: string) {
  const [row] = await db
    .select({ id: actorBlocks.id })
    .from(actorBlocks)
    .where(and(eq(actorBlocks.blockerId, blockerId), eq(actorBlocks.blockedId, blockedId)))
    .limit(1);
  return !!row;
}

export async function blockedEitherWay(db: Db, a: string, b: string) {
  const [row] = await db
    .select({ id: actorBlocks.id })
    .from(actorBlocks)
    .where(
      or(
        and(eq(actorBlocks.blockerId, a), eq(actorBlocks.blockedId, b)),
        and(eq(actorBlocks.blockerId, b), eq(actorBlocks.blockedId, a)),
      ),
    )
    .limit(1);
  return !!row;
}

/** Ids among `ids` that have blocked `authorId` (they get no mention). */
export async function idsBlocking(db: Db, authorId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: actorBlocks.blockerId })
    .from(actorBlocks)
    .where(and(eq(actorBlocks.blockedId, authorId), inArray(actorBlocks.blockerId, ids)));
  return new Set(rows.map((r) => r.id));
}

async function areFriends(db: Db, a: string, b: string) {
  const [row] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(
      and(
        eq(friendships.state, 'accepted'),
        or(
          and(eq(friendships.ownerActorId, a), eq(friendships.otherActorId, b)),
          and(eq(friendships.ownerActorId, b), eq(friendships.otherActorId, a)),
        ),
      ),
    )
    .limit(1);
  return !!row;
}

/** Both are members of some server (a Group's followers collection). */
async function shareServer(db: Db, aUri: string, bUri: string) {
  const rows = await db.execute(sql`
    SELECT 1 FROM collection_items a
    JOIN collection_items b ON b.collection_uri = a.collection_uri
    JOIN actors g ON g.followers_uri = a.collection_uri AND g.type = 'Group'
    WHERE a.item_uri = ${aUri} AND b.item_uri = ${bUri}
    LIMIT 1`);
  return rows.length > 0;
}

export async function isAllowlisted(db: Db, ownerId: string, otherId: string) {
  const [row] = await db
    .select({ id: dmAllowlist.id })
    .from(dmAllowlist)
    .where(and(eq(dmAllowlist.ownerId, ownerId), eq(dmAllowlist.allowedId, otherId)))
    .limit(1);
  return !!row;
}

export type OpenDecision = 'open' | 'request' | 'refuse';

/**
 * May `sender` start a new DM with `recipient`? `open` makes an ordinary
 * DM, `request` makes a message request, `refuse` makes nothing. Remote
 * recipients' own towers decide for them, so they are `open` here
 * unless one side has blocked the other.
 */
export async function decideOpen(db: Db, sender: Actor, recipient: Actor): Promise<OpenDecision> {
  if (await blockedEitherWay(db, sender.id, recipient.id)) return 'refuse';
  if (!recipient.local) return 'open';

  const [declined] = await db
    .select({ id: dmRequests.id })
    .from(dmRequests)
    .where(
      and(
        eq(dmRequests.fromId, sender.id),
        eq(dmRequests.toId, recipient.id),
        eq(dmRequests.state, 'declined'),
        gt(dmRequests.cooldownUntil, new Date()),
      ),
    )
    .limit(1);
  if (declined) return 'refuse';

  if (await isAllowlisted(db, recipient.id, sender.id)) return 'open';

  const policy = recipient.dmPolicy;
  if (policy === 'anyone') return 'open';
  if (policy === 'friends') {
    return (await areFriends(db, sender.id, recipient.id)) ? 'open' : 'request';
  }
  if (policy === 'members_of_shared_servers') {
    if (await areFriends(db, sender.id, recipient.id)) return 'open';
    return (await shareServer(db, sender.uri, recipient.uri)) ? 'open' : 'request';
  }
  // 'nobody', and anything unrecognized: fail closed.
  return 'refuse';
}

/** Current members of a DM. */
export async function dmMembers(db: Db, dm: DmRow): Promise<Actor[]> {
  const rows = await db
    .select({ actor: actors })
    .from(collectionItems)
    .innerJoin(actors, eq(collectionItems.itemId, actors.id))
    .where(eq(collectionItems.collectionUri, dm.uri));
  return rows.map((r) => r.actor);
}

export function isDMRow(row: DmRow | undefined | null): row is DmRow {
  const props = (row?.properties as Record<string, unknown> | null) ?? null;
  return !!row && row.belongsTo === null && props?.isDM === true;
}

/** A DM both actors are currently in. */
export async function findSharedDM(db: Db, a: Actor, b: Actor): Promise<DmRow | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT o.id FROM objects o
    JOIN collection_items ca ON ca.collection_uri = o.uri AND ca.item_uri = ${a.uri}
    JOIN collection_items cb ON cb.collection_uri = o.uri AND cb.item_uri = ${b.uri}
    WHERE o.belongs_to IS NULL AND (o.properties->>'isDM')::boolean IS TRUE
    ORDER BY o.published ASC
    LIMIT 1`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [dm] = await db.select().from(objects).where(eq(objects.id, id)).limit(1);
  return dm ?? null;
}

/** A DM `leaver` left (or declined) while `stayer` is still in it. */
export async function findDepartedDM(
  db: Db,
  leaver: Actor,
  stayer: Actor,
): Promise<{ dm: DmRow; reason: string } | null> {
  const rows = await db.execute<{ id: string; reason: string }>(sql`
    SELECT o.id, d.reason FROM objects o
    JOIN dm_departures d ON d.dm_id = o.id AND d.actor_id = ${leaver.id}
    JOIN collection_items cs ON cs.collection_uri = o.uri AND cs.item_uri = ${stayer.uri}
    WHERE o.belongs_to IS NULL
    ORDER BY d.left_at DESC
    LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const [dm] = await db.select().from(objects).where(eq(objects.id, row.id)).limit(1);
  return dm ? { dm, reason: row.reason } : null;
}

export async function requestFor(db: Db, dmId: string) {
  const [row] = await db.select().from(dmRequests).where(eq(dmRequests.dmId, dmId)).limit(1);
  return row ?? null;
}

async function countNotesBy(db: Db, dmId: string, actorId: string, since: Date) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(objects)
    .where(
      and(
        eq(objects.context, dmId),
        eq(objects.type, 'Note'),
        eq(objects.attributedTo, actorId),
        gte(objects.published, since),
      ),
    );
  return row?.n ?? 0;
}

export async function acceptRequest(db: Db, requestId: string) {
  await db
    .update(dmRequests)
    .set({ state: 'accepted', decidedAt: new Date(), cooldownUntil: null })
    .where(and(eq(dmRequests.id, requestId), eq(dmRequests.state, 'pending')));
}

export type PostDecision = { ok: true } | { ok: false; status: number; error: string };

/**
 * May `actor` post in this DM now? Called on every path that writes a
 * DM message (local routes and inbound federation). The recipient of a
 * pending request answering it accepts it.
 */
export async function checkDMPost(db: Db, dm: DmRow, actor: Actor): Promise<PostDecision> {
  const request = await requestFor(db, dm.id);
  if (request && request.fromId === actor.id && request.state !== 'accepted') {
    // Pending, or declined (which the requester isn't told about).
    if (
      request.state === 'declined' ||
      (await countNotesBy(db, dm.id, actor.id, request.createdAt)) >= PENDING_MESSAGE_LIMIT
    ) {
      return { ok: false, status: 403, error: REQUEST_WAITING };
    }
  }

  const others = (await dmMembers(db, dm)).filter((m) => m.id !== actor.id);
  if (others.length === 0) return { ok: false, status: 403, error: EVERYONE_LEFT };
  for (const other of others) {
    if (await blockedEitherWay(db, actor.id, other.id)) {
      return { ok: false, status: 403, error: REFUSED_POST };
    }
  }

  if (request && request.toId === actor.id && request.state === 'pending') {
    await acceptRequest(db, request.id);
  }
  return { ok: true };
}

/**
 * Throw a 403 (with the reason as its message) when `channelId` is a DM
 * `actor` may not post in now. A no-op for server channels.
 */
export async function assertCanPostInDM(db: Db, channelId: string, actor: Actor) {
  const [channel] = await db.select().from(objects).where(eq(objects.id, channelId)).limit(1);
  if (!isDMRow(channel)) return;
  const decision = await checkDMPost(db, channel, actor);
  if (!decision.ok) {
    throw Object.assign(new Error(decision.error), { statusCode: decision.status });
  }
}

/** Mentioned ids minus those who have blocked the author. */
export async function mentionableIds(db: Db, authorId: string, ids: string[]) {
  const blocking = await idsBlocking(db, authorId, ids);
  return ids.filter((id) => !blocking.has(id));
}

/** The conversation as `viewer` sees it. */
export async function conversationView(db: Db, dm: DmRow, viewer: Actor): Promise<DMConversation> {
  const members = await dmMembers(db, dm);
  const departed = await db
    .select({ actor: actors, reason: dmDepartures.reason })
    .from(dmDepartures)
    .innerJoin(actors, eq(dmDepartures.actorId, actors.id))
    .where(eq(dmDepartures.dmId, dm.id));
  const request = await requestFor(db, dm.id);

  // Someone who declined a request still shows as a participant to the
  // requester: declining is a quiet "no", not an announcement.
  const participants = [
    ...members,
    ...departed.filter((d) => d.reason === 'declined').map((d) => d.actor),
  ].map(toAuthorView);
  const left = departed.filter((d) => d.reason === 'left').map((d) => toAuthorView(d.actor));

  const [last] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.context, dm.id), eq(objects.type, 'Note')))
    .orderBy(sql`${objects.published} DESC`)
    .limit(1);
  const props = (dm.properties as Record<string, unknown> | null) ?? {};
  const readBy = props.readBy as Record<string, string> | undefined;

  return {
    id: dm.id,
    participants,
    ...(last ? { lastMessage: toMessageView(last) } : {}),
    ...(readBy ? { readBy } : {}),
    ...(left.length > 0 ? { left } : {}),
    ...(request && (request.fromId === viewer.id || request.toId === viewer.id)
      ? {
          request: {
            state: request.state === 'accepted' ? 'accepted' : 'pending',
            incoming: request.toId === viewer.id,
          },
        }
      : {}),
  };
}

/** Put the leaver back: only they may do this (POST /dms by them). */
export async function rejoinDM(db: Db, dm: DmRow, actor: Actor) {
  await db.transaction(async (tx) => {
    await tx
      .delete(dmDepartures)
      .where(and(eq(dmDepartures.dmId, dm.id), eq(dmDepartures.actorId, actor.id)));
    await tx
      .insert(collectionItems)
      .values({ collectionUri: dm.uri, collectionId: dm.id, itemUri: actor.uri, itemId: actor.id })
      .onConflictDoNothing();
  });
}

/**
 * `actor` leaves `dm`. They stop receiving it at once (membership row,
 * WS subscriptions, and inbound federation, which checks departures),
 * and the others see "left". Leaving a pending request declines it.
 * `reason: 'declined'` is the quiet version used by the decline route:
 * nobody is told.
 */
export async function leaveDM(
  fastify: FastifyInstance,
  dm: DmRow,
  actor: Actor,
  reason: 'left' | 'declined' = 'left',
) {
  const db = fastify.db;
  const others = (await dmMembers(db, dm)).filter((m) => m.id !== actor.id);
  await db.transaction(async (tx) => {
    await tx
      .delete(collectionItems)
      .where(
        and(eq(collectionItems.collectionUri, dm.uri), eq(collectionItems.itemUri, actor.uri)),
      );
    await tx
      .insert(dmDepartures)
      .values({ dmId: dm.id, actorId: actor.id, reason })
      .onConflictDoUpdate({
        target: [dmDepartures.dmId, dmDepartures.actorId],
        set: { reason, leftAt: new Date() },
      });
    await tx
      .update(dmRequests)
      .set({
        state: 'declined',
        decidedAt: new Date(),
        cooldownUntil: new Date(Date.now() + DECLINE_COOLDOWN_MS),
      })
      .where(
        and(
          eq(dmRequests.dmId, dm.id),
          eq(dmRequests.toId, actor.id),
          eq(dmRequests.state, 'pending'),
        ),
      );
  });

  fastify.wsUnsubscribeActor(actor.id, dm.id);
  fastify.broadcastToActor(actor.id, { type: 'dm:removed', payload: { dmId: dm.id } });
  if (reason === 'left') {
    fastify.broadcastToChannel(dm.id, {
      type: 'dm:left',
      payload: { dmId: dm.id, actor: toAuthorView(actor) },
    });
  }

  // Remote participants' towers keep their own copy of the DM; tell
  // them, so they stop showing us as in it. Babelr extension: the
  // object is our DM collection and `babelrDM` marks it as one.
  const remotes = others.filter((o) => !o.local && o.inboxUri);
  if (reason === 'left' && actor.local && remotes.length > 0) {
    const config = fastify.config;
    const protocol = config.secureCookies ? 'https' : 'http';
    ensureActorKeys(db, actor)
      .then(async (withKeys) => {
        for (const r of remotes) {
          const activity = {
            ...serializeActivity(
              `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`,
              'Leave',
              actor.uri,
              { type: 'OrderedCollection', id: dm.uri, babelrDM: true },
              [r.uri],
              [],
            ),
          };
          await enqueueDelivery(db, activity, r.inboxUri!, withKeys.id);
        }
      })
      .catch((err) => fastify.log.error(err, 'DM Leave delivery failed'));
  }

  if (isSponsoredKind(actor.kind)) {
    await writeAuditLog(db, {
      serverId: null,
      actorId: actor.id,
      sponsorId: actor.sponsorId,
      category: 'agent',
      action: reason === 'left' ? 'dm.leave' : 'dm.request.decline',
      summary: `@${actor.preferredUsername} ${reason === 'left' ? 'left a DM' : 'declined a message request'}`,
      details: { dmId: dm.id },
    });
  }
}

/**
 * `requester` asks again after `recipient` declined (and the cooldown
 * passed, or the recipient's policy now lets them in): the same DM, with
 * the recipient back in it and a fresh request, or an accepted one if
 * the policy now opens directly.
 */
export async function reopenDeclined(
  db: Db,
  dm: DmRow,
  requester: Actor,
  recipient: Actor,
  decision: 'open' | 'request',
) {
  await rejoinDM(db, dm, recipient);
  await createRequest(db, dm.id, requester.id, recipient.id);
  if (decision === 'open') {
    const req = await requestFor(db, dm.id);
    if (req) await acceptRequest(db, req.id);
  }
}

/** Insert or reuse the (from, to) request row for a new DM. */
export async function createRequest(db: Db, dmId: string, fromId: string, toId: string) {
  await db
    .insert(dmRequests)
    .values({ dmId, fromId, toId, state: 'pending' })
    .onConflictDoUpdate({
      target: [dmRequests.fromId, dmRequests.toId],
      set: { dmId, state: 'pending', createdAt: new Date(), decidedAt: null, cooldownUntil: null },
    });
}

/** Make a new two-person DM collection. */
export async function createDM(fastify: FastifyInstance, a: Actor, b: Actor): Promise<DmRow> {
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';
  const dmUri = `${protocol}://${config.domain}/dms/${crypto.randomUUID()}`;
  return fastify.db.transaction(async (tx) => {
    const [dm] = await tx
      .insert(objects)
      .values({
        uri: dmUri,
        type: 'OrderedCollection',
        belongsTo: null,
        properties: { name: null, isDM: true },
      })
      .returning();
    await tx.insert(collectionItems).values([
      { collectionUri: dm.uri, collectionId: dm.id, itemUri: a.uri, itemId: a.id },
      { collectionUri: dm.uri, collectionId: dm.id, itemUri: b.uri, itemId: b.id },
    ]);
    return dm;
  });
}

/**
 * Where an inbound federated DM from `remote` to `local` goes: a DM id,
 * or null to drop it. Same rules as local senders: blocks, the policy
 * (a request where it says so), a pending request's one message, and
 * no re-entry into a DM `local` left.
 */
export async function inboundDMTarget(
  fastify: FastifyInstance,
  local: Actor,
  remote: Actor,
): Promise<{ dmId: string; isNew: boolean; isRequest: boolean } | null> {
  const db = fastify.db;
  if (await blockedEitherWay(db, local.id, remote.id)) return null;

  const existing = await findSharedDM(db, local, remote);
  if (existing) {
    const decision = await checkDMPost(db, existing, remote);
    return decision.ok ? { dmId: existing.id, isNew: false, isRequest: false } : null;
  }
  const departed = await findDepartedDM(db, local, remote);
  if (departed && departed.reason !== 'declined') return null;

  // The remote actor left one with us and is writing again: coming
  // back is the leaver's own call.
  const theirs = await findDepartedDM(db, remote, local);
  if (theirs && theirs.reason === 'left') {
    await rejoinDM(db, theirs.dm, remote);
    return { dmId: theirs.dm.id, isNew: false, isRequest: false };
  }

  const decision = await decideOpen(db, remote, local);
  if (decision === 'refuse') return null;
  if (departed) {
    await reopenDeclined(db, departed.dm, remote, local, decision);
    return { dmId: departed.dm.id, isNew: true, isRequest: decision === 'request' };
  }
  const dm = await createDM(fastify, local, remote);
  if (decision === 'request') await createRequest(db, dm.id, remote.id, local.id);
  return { dmId: dm.id, isNew: true, isRequest: decision === 'request' };
}

/** Local DMs `local` shares with `remote`, for an inbound Leave. */
export async function handleRemoteLeave(
  fastify: FastifyInstance,
  remote: Actor,
  localTargets: Actor[],
) {
  for (const local of localTargets) {
    const dm = await findSharedDM(fastify.db, local, remote);
    if (dm) await leaveDM(fastify, dm, remote, 'left');
  }
}

/** DMs the actor is currently in, with no unanswered incoming request. */
export async function dmIdsFor(db: Db, actor: Actor) {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT o.id FROM objects o
    JOIN collection_items c ON c.collection_uri = o.uri AND c.item_uri = ${actor.uri}
    WHERE o.belongs_to IS NULL AND (o.properties->>'isDM')::boolean IS TRUE`);
  return rows.map((r) => r.id);
}

export async function pendingIncomingDMIds(db: Db, actor: Actor) {
  const rows = await db
    .select({ dmId: dmRequests.dmId })
    .from(dmRequests)
    .where(and(eq(dmRequests.toId, actor.id), eq(dmRequests.state, 'pending')));
  return rows.map((r) => r.dmId);
}
