// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import './types.ts';
import type { Database } from './db/index.ts';
import { actors } from './db/schema/actors.ts';
import { objects } from './db/schema/objects.ts';
import { collectionItems } from './db/schema/collections.ts';
import { dmRequests } from './db/schema/dm-consent.ts';
import { inviteArrivals, welcomes } from './db/schema/welcome.ts';
import { guestCardFacts, guestCards } from './db/schema/guest-cards.ts';
import { invites } from './db/schema/invites.ts';
import type { GuestCardFact, WelcomeState, WelcomeView } from '@babelr/shared';
import { toAuthorView } from './serializers.ts';
import { writeAuditLog } from './audit.ts';
import {
  blockedEitherWay,
  conversationView,
  decideOpen,
  findDepartedDM,
  findSharedDM,
} from './dm-consent.ts';

/**
 * Welcoming newcomers. When a person joins a server, every member who
 * opted in to welcoming there (server_welcomers, a row only that member
 * can add, with its own session or token) gets a DM with them, and a
 * welcome (GET /welcomes, a `welcome:new` WS event) saying who arrived
 * and through whose invite. The hello is the welcomer's to write:
 * nothing here sends a message in anyone's name.
 *
 * Consent, both ways:
 * - the welcomer's opt-in is its yes to newcomers on that server, so
 *   its own DM policy (agents default to `nobody`) doesn't wall off the
 *   conversation it asked for. That yes covers only this DM.
 * - the newcomer's own policy decides as it would for anyone: open (a
 *   new account's default, `anyone`), a message request, or nothing.
 * - a block either way, a DM either of them left, or a declined request
 *   between them means no welcome DM at all.
 * - the newcomer can block or leave a welcome DM like any other.
 *
 * Idempotent: one welcome per (server, newcomer, welcomer), claimed by a
 * unique index inside the same transaction that makes the DM. Join
 * routes call `welcomeNewcomer` directly; `catchUpNewcomer` (GET /dms)
 * and `catchUpWelcomer` (GET /welcomes) repair any join that happened
 * without the call (a crash, or a code path that adds members without
 * it), within WELCOME_WINDOW_MS of the join.
 */

type Actor = typeof actors.$inferSelect;
type Db = Database;
type WelcomeRow = typeof welcomes.$inferSelect;

/** How far back the catch-up sweeps look for joins nobody welcomed. */
export const WELCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function hasPublicKey(a: Actor): boolean {
  const k = (a.properties as Record<string, unknown> | null)?.publicKey as
    | Record<string, unknown>
    | undefined;
  return !!k && typeof k.x === 'string' && typeof k.y === 'string';
}

/** Someone a welcome can be for: a local person, not suspended. */
function isNewcomerKind(a: Actor): boolean {
  return a.local && a.type === 'Person' && a.kind === 'person' && !a.suspendedAt;
}

function serverName(s: Actor): string {
  return s.displayName ?? s.preferredUsername;
}

export interface WelcomeOptions {
  /** Who made the invite they came in on. */
  invitedById?: string | null;
  /** How they arrived, for the audit log: 'invite', 'join', 'register', 'catch-up'. */
  via: string;
  /** Only this welcomer (the welcomer-side catch-up). */
  onlyWelcomerId?: string;
}

/**
 * Welcome `newcomer` to `server` from each member who opted in before
 * they joined and hasn't welcomed them yet. Never throws: a welcome
 * that fails is logged and left for the catch-up sweep, and the join
 * that called this goes through regardless.
 */
export async function welcomeNewcomer(
  fastify: FastifyInstance,
  server: Actor,
  newcomer: Actor,
  opts: WelcomeOptions,
): Promise<WelcomeRow[]> {
  const db = fastify.db;
  const made: WelcomeRow[] = [];
  try {
    if (!isNewcomerKind(newcomer) || server.type !== 'Group' || !server.followersUri) return made;
    const [membership] = await db
      .select({ addedAt: collectionItems.addedAt })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, server.followersUri),
          eq(collectionItems.itemUri, newcomer.uri),
        ),
      )
      .limit(1);
    if (!membership) return made;
    if (opts.invitedById === undefined) {
      const [arrival] = await db
        .select({ invitedById: inviteArrivals.invitedById })
        .from(inviteArrivals)
        .where(and(eq(inviteArrivals.serverId, server.id), eq(inviteArrivals.actorId, newcomer.id)))
        .limit(1);
      if (arrival) opts = { ...opts, invitedById: arrival.invitedById };
    }

    // Opted in before the join, still a member, still able to act, and
    // not already handled for this newcomer.
    const candidates = await db.execute<{ id: string }>(sql`
      SELECT a.id FROM server_welcomers w
      JOIN actors a ON a.id = w.actor_id
      JOIN collection_items m ON m.collection_uri = ${server.followersUri} AND m.item_uri = a.uri
      WHERE w.server_id = ${server.id}
        AND w.created_at <= ${membership.addedAt.toISOString()}
        AND a.id <> ${newcomer.id}
        AND a.local AND a.suspended_at IS NULL
        ${opts.onlyWelcomerId ? sql`AND a.id = ${opts.onlyWelcomerId}` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM welcomes x
          WHERE x.server_id = w.server_id AND x.newcomer_id = ${newcomer.id} AND x.welcomer_id = a.id
        )
      ORDER BY w.created_at ASC`);
    if (candidates.length === 0) return made;
    const welcomers = await db
      .select()
      .from(actors)
      .where(
        inArray(
          actors.id,
          candidates.map((c) => c.id),
        ),
      );
    for (const welcomer of welcomers) {
      try {
        const row = await welcomeOne(fastify, server, welcomer, newcomer, opts);
        if (row) made.push(row);
      } catch (err) {
        fastify.log.error(
          { err, serverId: server.id, newcomerId: newcomer.id, welcomerId: welcomer.id },
          'Welcome failed; the catch-up sweep will retry it',
        );
      }
    }
  } catch (err) {
    fastify.log.error({ err, serverId: server.id, newcomerId: newcomer.id }, 'Welcome failed');
  }
  return made;
}

/** `welcomeNewcomer` by ids, for routes that hold only ids. */
export async function welcomeAfterJoin(
  fastify: FastifyInstance,
  serverId: string,
  newcomerId: string,
  opts: WelcomeOptions,
): Promise<WelcomeRow[]> {
  try {
    const rows = await fastify.db
      .select()
      .from(actors)
      .where(or(eq(actors.id, serverId), eq(actors.id, newcomerId)));
    const server = rows.find((r) => r.id === serverId);
    const newcomer = rows.find((r) => r.id === newcomerId);
    if (!server || !newcomer) return [];
    return await welcomeNewcomer(fastify, server, newcomer, opts);
  } catch (err) {
    fastify.log.error({ err, serverId, newcomerId }, 'Welcome failed');
    return [];
  }
}

type Plan =
  | { kind: 'skip'; reason: string }
  | { kind: 'reuse'; dmId: string }
  | { kind: 'open'; request: boolean };

/** What consent allows between this welcomer and this newcomer. */
async function planWelcome(db: Db, welcomer: Actor, newcomer: Actor): Promise<Plan> {
  if (await blockedEitherWay(db, welcomer.id, newcomer.id))
    return { kind: 'skip', reason: 'blocked' };
  if (!hasPublicKey(welcomer)) return { kind: 'skip', reason: 'no_key' };

  const shared = await findSharedDM(db, welcomer, newcomer);
  if (shared) return { kind: 'reuse', dmId: shared.id };

  // Either of them walked out of one before: nobody puts them back.
  if (
    (await findDepartedDM(db, newcomer, welcomer)) ||
    (await findDepartedDM(db, welcomer, newcomer))
  ) {
    return { kind: 'skip', reason: 'left' };
  }
  const [declined] = await db
    .select({ id: dmRequests.id })
    .from(dmRequests)
    .where(
      and(
        eq(dmRequests.state, 'declined'),
        gt(dmRequests.cooldownUntil, new Date()),
        or(
          and(eq(dmRequests.fromId, welcomer.id), eq(dmRequests.toId, newcomer.id)),
          and(eq(dmRequests.fromId, newcomer.id), eq(dmRequests.toId, welcomer.id)),
        ),
      ),
    )
    .limit(1);
  if (declined) return { kind: 'skip', reason: 'declined' };

  // The newcomer's policy, as for anyone who wants to talk to them. The
  // welcomer's own policy isn't asked: opting in was its answer.
  const decision = await decideOpen(db, welcomer, newcomer);
  if (decision === 'refuse') return { kind: 'skip', reason: 'newcomer_policy' };
  return { kind: 'open', request: decision === 'request' };
}

async function welcomeOne(
  fastify: FastifyInstance,
  server: Actor,
  welcomer: Actor,
  newcomer: Actor,
  opts: WelcomeOptions,
): Promise<WelcomeRow | null> {
  const db = fastify.db;
  const plan = await planWelcome(db, welcomer, newcomer);
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  const result = await db.transaction(async (tx) => {
    // The claim. A retry, a second join or a concurrent sweep hits the
    // unique index and does nothing; if this transaction rolls back, the
    // claim goes with it and the next try starts clean.
    const [claimed] = await tx
      .insert(welcomes)
      .values({
        serverId: server.id,
        newcomerId: newcomer.id,
        welcomerId: welcomer.id,
        invitedById: opts.invitedById ?? null,
        state: plan.kind === 'skip' ? 'skipped' : 'pending',
        reason:
          plan.kind === 'skip'
            ? plan.reason
            : plan.kind === 'open' && plan.request
              ? 'request'
              : null,
        dmId: plan.kind === 'reuse' ? plan.dmId : null,
      })
      .onConflictDoNothing()
      .returning();
    if (!claimed) return null;
    if (plan.kind !== 'open') return { row: claimed, dmId: claimed.dmId, created: false };

    const [dm] = await tx
      .insert(objects)
      .values({
        uri: `${protocol}://${config.domain}/dms/${crypto.randomUUID()}`,
        type: 'OrderedCollection',
        belongsTo: null,
        properties: { name: null, isDM: true },
      })
      .returning();
    await tx.insert(collectionItems).values([
      { collectionUri: dm.uri, collectionId: dm.id, itemUri: welcomer.uri, itemId: welcomer.id },
      { collectionUri: dm.uri, collectionId: dm.id, itemUri: newcomer.uri, itemId: newcomer.id },
    ]);
    if (plan.request) {
      // Same row shape createRequest writes: the newcomer's policy made
      // this a message request, with its one message.
      await tx
        .insert(dmRequests)
        .values({ dmId: dm.id, fromId: welcomer.id, toId: newcomer.id, state: 'pending' })
        .onConflictDoUpdate({
          target: [dmRequests.fromId, dmRequests.toId],
          set: {
            dmId: dm.id,
            state: 'pending',
            sentCount: 0,
            createdAt: new Date(),
            decidedAt: null,
            cooldownUntil: null,
          },
        });
    }
    const [row] = await tx
      .update(welcomes)
      .set({ dmId: dm.id })
      .where(eq(welcomes.id, claimed.id))
      .returning();
    return { row, dmId: dm.id, created: true };
  });
  if (!result) return null;
  const { row, dmId, created } = result;

  const skipped = plan.kind === 'skip';
  await writeAuditLog(db, {
    serverId: server.id,
    actorId: welcomer.id,
    sponsorId: welcomer.sponsorId,
    category: 'welcome',
    action: skipped ? 'welcome.skip' : 'welcome.open',
    summary: skipped
      ? `No welcome DM from @${welcomer.preferredUsername} to newcomer @${newcomer.preferredUsername} (${plan.reason})`
      : `Welcome DM between newcomer @${newcomer.preferredUsername} and @${welcomer.preferredUsername}`,
    details: {
      welcomeId: row.id,
      newcomerId: newcomer.id,
      welcomerId: welcomer.id,
      invitedById: opts.invitedById ?? null,
      via: opts.via,
      dmId,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(plan.kind === 'reuse' ? { reusedDM: true } : {}),
    },
  });
  if (skipped) return row;

  if (created && dmId) {
    const [dm] = await db.select().from(objects).where(eq(objects.id, dmId)).limit(1);
    const isRequest = plan.kind === 'open' && plan.request;
    fastify.broadcastToActor(newcomer.id, {
      type: isRequest ? 'dm:request' : 'conversation:new',
      payload: { conversation: await conversationView(db, dm, newcomer) },
    });
    fastify.broadcastToActor(welcomer.id, {
      type: 'conversation:new',
      payload: { conversation: await conversationView(db, dm, welcomer) },
    });
  }
  fastify.broadcastToActor(welcomer.id, {
    type: 'welcome:new',
    payload: { welcome: await welcomeView(db, row) },
  });
  return row;
}

/** The welcome as its welcomer sees it. */
export async function welcomeView(db: Db, row: WelcomeRow): Promise<WelcomeView> {
  return (await welcomeViews(db, [row]))[0];
}

export async function welcomeViews(db: Db, rows: WelcomeRow[]): Promise<WelcomeView[]> {
  if (rows.length === 0) return [];
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.serverId, r.newcomerId, ...(r.invitedById ? [r.invitedById] : [])]),
    ),
  ];
  const people = await db.select().from(actors).where(inArray(actors.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  const arrivals = await db
    .select({ arrival: inviteArrivals, card: guestCards })
    .from(inviteArrivals)
    .leftJoin(guestCards, eq(guestCards.id, inviteArrivals.guestCardId))
    .where(
      inArray(
        inviteArrivals.actorId,
        rows.map((r) => r.newcomerId),
      ),
    );
  const facts = await factsFor(
    db,
    arrivals.map((a) => a.card?.id).filter((x): x is string => !!x),
  );
  const arrivalOf = (serverId: string, actorId: string) =>
    arrivals.find((a) => a.arrival.serverId === serverId && a.arrival.actorId === actorId);
  const out: WelcomeView[] = [];
  for (const r of rows) {
    const server = byId.get(r.serverId);
    const newcomer = byId.get(r.newcomerId);
    if (!server || !newcomer) continue;
    const inviter = r.invitedById ? byId.get(r.invitedById) : undefined;
    const arrived = arrivalOf(r.serverId, r.newcomerId);
    const card = arrived?.card ?? null;
    const consent = arrived?.arrival.lookupConsent ?? null;
    out.push({
      id: r.id,
      server: { id: server.id, name: serverName(server) },
      newcomer: toAuthorView(newcomer),
      invitedBy: inviter ? toAuthorView(inviter) : null,
      dmId: r.dmId,
      state: r.state as WelcomeState,
      reason: r.reason,
      newcomerKeyReady: hasPublicKey(newcomer),
      invitedAs: card?.label ?? null,
      card: card
        ? {
            id: card.id,
            name: card.name,
            label: card.label,
            note: card.note,
            // Only with the person's yes: "No thanks" (or no answer yet) carries none.
            seeds: consent === true ? withAddedLink(card.seeds, arrived!.arrival.addedLink) : null,
            facts: consent === true ? (facts.get(card.id) ?? []) : [],
          }
        : null,
      consented: card && needsConsent(card, facts) ? consent : null,
      seedsPending: !!card && needsConsent(card, facts) && consent === null,
      createdAt: r.createdAt.toISOString(),
      doneAt: r.doneAt?.toISOString() ?? null,
    });
  }
  return out;
}

/** Joins of `actor`'s within the window that some opted-in member hasn't welcomed. */
export async function catchUpNewcomer(fastify: FastifyInstance, actor: Actor): Promise<void> {
  if (!isNewcomerKind(actor)) return;
  try {
    const since = new Date(Date.now() - WELCOME_WINDOW_MS).toISOString();
    const rows = await fastify.db.execute<{ id: string }>(sql`
      SELECT DISTINCT g.id FROM collection_items m
      JOIN actors g ON g.followers_uri = m.collection_uri AND g.type = 'Group' AND g.local
      JOIN server_welcomers w ON w.server_id = g.id AND w.created_at <= m.added_at
      WHERE m.item_uri = ${actor.uri}
        AND m.added_at > ${since}
        AND w.actor_id <> ${actor.id}
        AND NOT EXISTS (
          SELECT 1 FROM welcomes x
          WHERE x.server_id = g.id AND x.newcomer_id = ${actor.id} AND x.welcomer_id = w.actor_id
        )`);
    if (rows.length === 0) return;
    const servers = await fastify.db
      .select()
      .from(actors)
      .where(
        inArray(
          actors.id,
          rows.map((r) => r.id),
        ),
      );
    for (const server of servers) {
      await welcomeNewcomer(fastify, server, actor, { via: 'catch-up' });
    }
  } catch (err) {
    fastify.log.error({ err, actorId: actor.id }, 'Welcome catch-up failed');
  }
}

/** People who joined `welcomer`'s servers since it opted in, within the window, not yet welcomed. */
export async function catchUpWelcomer(fastify: FastifyInstance, welcomer: Actor): Promise<void> {
  try {
    const since = new Date(Date.now() - WELCOME_WINDOW_MS).toISOString();
    const rows = await fastify.db.execute<{ server_id: string; newcomer_id: string }>(sql`
      SELECT w.server_id, a.id AS newcomer_id FROM server_welcomers w
      JOIN actors g ON g.id = w.server_id AND g.type = 'Group'
      JOIN collection_items m ON m.collection_uri = g.followers_uri
      JOIN actors a ON a.uri = m.item_uri
      WHERE w.actor_id = ${welcomer.id}
        AND m.added_at >= w.created_at
        AND m.added_at > ${since}
        AND a.local AND a.type = 'Person' AND a.kind = 'person' AND a.id <> ${welcomer.id}
        AND NOT EXISTS (
          SELECT 1 FROM welcomes x
          WHERE x.server_id = w.server_id AND x.newcomer_id = a.id AND x.welcomer_id = ${welcomer.id}
        )
      LIMIT 50`);
    for (const r of rows) {
      await welcomeAfterJoin(fastify, r.server_id, r.newcomer_id, {
        via: 'catch-up',
        onlyWelcomerId: welcomer.id,
      });
    }
  } catch (err) {
    fastify.log.error({ err, actorId: welcomer.id }, 'Welcome catch-up failed');
  }
}

/**
 * Pending welcomes whose welcomer has already written in the DM are
 * done: the hello happened, whether or not it was marked.
 */
export async function settleSaidHello(db: Db, welcomerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE welcomes w SET state = 'done', done_at = now()
    WHERE w.welcomer_id = ${welcomerId} AND w.state = 'pending' AND w.dm_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM objects o
        WHERE o.context = w.dm_id AND o.type = 'Note' AND o.attributed_to = ${welcomerId}
      )`);
}

function withAddedLink(seeds: string | null, link: string | null): string | null {
  if (!link) return seeds;
  return seeds ? `${seeds}\n${link}` : link;
}

/**
 * Record how `newcomerId` came into the invite's server: who invited
 * them, and the guest card the invite was made from. Only for a
 * membership that started after the invite existed (a long-time member
 * opening a link isn't "invited as" anyone). First arrival wins.
 */
export async function recordArrival(
  db: Db,
  invite: typeof invites.$inferSelect,
  newcomerId: string,
): Promise<void> {
  const rows = await db.execute<{ added_at: string }>(sql`
    SELECT m.added_at FROM collection_items m
    JOIN actors g ON g.followers_uri = m.collection_uri AND g.id = ${invite.serverId}
    WHERE m.item_id = ${newcomerId} AND m.added_at >= ${invite.createdAt.toISOString()}
    LIMIT 1`);
  if (rows.length === 0) return;
  await db
    .insert(inviteArrivals)
    .values({
      serverId: invite.serverId,
      actorId: newcomerId,
      inviteId: invite.id,
      invitedById: invite.createdBy,
      guestCardId: invite.guestCardId,
    })
    .onConflictDoNothing();
}

/** Facts per card id, oldest first. */
export async function factsFor(db: Db, cardIds: string[]): Promise<Map<string, GuestCardFact[]>> {
  const out = new Map<string, GuestCardFact[]>();
  if (cardIds.length === 0) return out;
  const rows = await db
    .select()
    .from(guestCardFacts)
    .where(inArray(guestCardFacts.cardId, [...new Set(cardIds)]))
    .orderBy(guestCardFacts.createdAt);
  for (const f of rows) {
    const list = out.get(f.cardId) ?? [];
    list.push({
      id: f.id,
      key: f.key,
      value: f.value,
      source: f.source,
      addedBy: f.addedBy,
      createdAt: f.createdAt.toISOString(),
    });
    out.set(f.cardId, list);
  }
  return out;
}

/** The person is asked before the house uses a card that says anything about them. */
export function needsConsent(
  card: { id: string; seeds: string | null },
  facts: Map<string, GuestCardFact[]>,
): boolean {
  return !!card.seeds || (facts.get(card.id)?.length ?? 0) > 0;
}
