// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { invites } from '../db/schema/invites.ts';
import { guestCardFacts, guestCards } from '../db/schema/guest-cards.ts';
import { inviteArrivals, serverWelcomers, welcomes } from '../db/schema/welcome.ts';
import {
  PERMISSIONS,
  type ArrivalConsentView,
  type GuestCardStatus,
  type GuestCardView,
} from '@babelr/shared';
import { toAuthorView } from '../serializers.ts';
import { writeAuditLog } from '../audit.ts';
import { hasPermission } from '../permissions.ts';
import { publicOrigin } from '../registration.ts';
import { factsFor, needsConsent, welcomeViews } from '../welcome.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { name: 100, label: 64, seeds: 2000, note: 8000, link: 500 };

type Actor = typeof actors.$inferSelect;
type Card = typeof guestCards.$inferSelect;
type CardFields = { name: string; label: string | null; seeds: string | null; note: string | null };

/** Trimmed text within `max`, null when empty; an error string when not text or too long. */
function text(v: unknown, max: number, field: string): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return { error: `${field} must be text` };
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (t.length > max) return { error: `${field} is longer than ${max} characters` };
  return t || null;
}

const MAX_FACTS = 20;

/** The inviter's facts: [{ key, value }], or undefined when not given. */
function parseFacts(
  v: unknown,
): Array<{ key: string; value: string }> | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_FACTS) {
    return { error: `facts is a list of up to ${MAX_FACTS} { key, value }` };
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const f of v) {
    const o = (f ?? {}) as Record<string, unknown>;
    const key = text(o.key, 64, 'fact key');
    const value = text(o.value, 500, 'fact value');
    if (key && typeof key === 'object') return key;
    if (value && typeof value === 'object') return value;
    if (!key || !value) return { error: 'each fact needs a key and a value' };
    out.push({ key, value });
  }
  return out;
}

function parseCard(body: Record<string, unknown>): CardFields | { error: string } {
  const out: Record<string, string | null> = {};
  for (const f of ['name', 'label', 'seeds', 'note'] as const) {
    const v = text(body[f], LIMITS[f], f);
    if (v && typeof v === 'object') return v;
    out[f] = v;
  }
  if (!out.name) return { error: 'name is required' };
  return out as CardFields;
}

/**
 * Guest cards (schema/guest-cards.ts) and the newcomer's consent to the
 * house using what a card says about them.
 *
 * GET    /servers/:serverId/guest-cards   yours; all for managers and welcomers
 * POST   /servers/:serverId/guest-cards   { name, label?, seeds?, note? }
 * PUT    /guest-cards/:cardId             yours only
 * DELETE /guest-cards/:cardId             yours only
 * POST   /guest-cards/:cardId/invite      a single-use invite from the card;
 *                                         replaces the card's earlier link
 * GET    /me/arrivals[?pending=true]      what inviters told the house about me
 * PUT    /me/arrivals/:arrivalId/consent  { consent: boolean, link?: string }
 *
 * Cards are made with a person's session (CREATE_INVITES); tokens can only
 * read them (a welcomer daemon preparing). The person a card is about sees
 * the inviter's name and the seeds, verbatim, never the label, name or note.
 */
export default async function guestCardRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  function requireActor(request: FastifyRequest, reply: FastifyReply): Actor | null {
    if (!request.actor) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    return request.actor;
  }

  async function memberServer(serverId: string, me: Actor): Promise<Actor | null> {
    if (!UUID_RE.test(serverId)) return null;
    const [row] = await db
      .select({ server: actors })
      .from(actors)
      .innerJoin(
        collectionItems,
        and(
          eq(collectionItems.collectionUri, actors.followersUri),
          eq(collectionItems.itemUri, me.uri),
        ),
      )
      .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
      .limit(1);
    return row?.server ?? null;
  }

  async function isWelcomer(serverId: string, actorId: string) {
    const [row] = await db
      .select({ id: serverWelcomers.id })
      .from(serverWelcomers)
      .where(and(eq(serverWelcomers.serverId, serverId), eq(serverWelcomers.actorId, actorId)))
      .limit(1);
    return !!row;
  }

  async function ownCard(cardId: string, me: Actor, reply: FastifyReply): Promise<Card | null> {
    if (!UUID_RE.test(cardId)) {
      reply.status(404).send({ error: 'Card not found' });
      return null;
    }
    const [card] = await db
      .select()
      .from(guestCards)
      .where(and(eq(guestCards.id, cardId), eq(guestCards.createdBy, me.id)))
      .limit(1);
    if (!card) {
      reply.status(404).send({ error: 'Card not found' });
      return null;
    }
    return card;
  }

  /** Cards as `viewer` may see them. `full`: the inviter's or a manager's view. */
  async function views(
    cards: Card[],
    viewer: Actor,
    full: (c: Card) => boolean,
    request: FastifyRequest,
  ): Promise<GuestCardView[]> {
    if (cards.length === 0) return [];
    const ids = cards.map((c) => c.id);
    const arrivals = await db
      .select({ arrival: inviteArrivals, actor: actors })
      .from(inviteArrivals)
      .innerJoin(actors, eq(actors.id, inviteArrivals.actorId))
      .where(inArray(inviteArrivals.guestCardId, ids));
    const live = await db
      .select()
      .from(invites)
      .where(
        and(
          inArray(invites.guestCardId, ids),
          or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
          or(isNull(invites.maxUses), sql`${invites.uses} < ${invites.maxUses}`),
        ),
      )
      .orderBy(desc(invites.createdAt));
    const facts = await factsFor(db, ids);
    const makers = await db
      .select()
      .from(actors)
      .where(inArray(actors.id, [...new Set(cards.map((c) => c.createdBy))]));
    const origin = publicOrigin(fastify.config, request);
    return cards.map((c) => {
      const arrived = arrivals.find((a) => a.arrival.guestCardId === c.id);
      const consent = arrived?.arrival.lookupConsent ?? null;
      const inv = live.find((i) => i.guestCardId === c.id);
      const status: GuestCardStatus = arrived
        ? consent === false
          ? 'declined_lookup'
          : 'joined'
        : inv
          ? 'link_made'
          : 'not_sent';
      const isFull = full(c);
      const maker = makers.find((m) => m.id === c.createdBy)!;
      return {
        id: c.id,
        serverId: c.serverId,
        name: c.name,
        label: c.label,
        // A welcomer doesn't get seeds the person said no to.
        seeds: !isFull && consent === false ? null : c.seeds,
        facts: !isFull && consent === false ? [] : (facts.get(c.id) ?? []),
        note: c.note,
        createdBy: toAuthorView(maker),
        mine: c.createdBy === viewer.id,
        status,
        invite: isFull && inv ? { code: inv.code, url: `${origin}/invite/${inv.code}` } : null,
        joined: arrived ? toAuthorView(arrived.actor) : null,
        lookupConsent: consent,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });
  }

  fastify.get<{ Params: { serverId: string } }>(
    '/servers/:serverId/guest-cards',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const server = await memberServer(request.params.serverId, me);
      if (!server) return reply.status(404).send({ error: 'Server not found' });
      const manager = await hasPermission(db, server.id, me.id, PERMISSIONS.MANAGE_SERVER);
      const welcomer = await isWelcomer(server.id, me.id);
      const cards = await db
        .select()
        .from(guestCards)
        .where(
          manager || welcomer
            ? eq(guestCards.serverId, server.id)
            : and(eq(guestCards.serverId, server.id), eq(guestCards.createdBy, me.id)),
        )
        .orderBy(desc(guestCards.createdAt));
      return views(cards, me, (c) => manager || c.createdBy === me.id, request);
    },
  );

  fastify.post<{ Params: { serverId: string }; Body: Record<string, unknown> }>(
    '/servers/:serverId/guest-cards',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const server = await memberServer(request.params.serverId, me);
      if (!server) return reply.status(404).send({ error: 'Server not found' });
      if (!(await hasPermission(db, server.id, me.id, PERMISSIONS.CREATE_INVITES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
      const fields = parseCard(request.body ?? {});
      if ('error' in fields) return reply.status(400).send({ error: fields.error });
      const facts = parseFacts(request.body?.facts);
      if (facts && 'error' in facts) return reply.status(400).send({ error: facts.error });
      const card = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(guestCards)
          .values({ serverId: server.id, createdBy: me.id, ...fields })
          .returning();
        if (facts?.length) {
          await tx
            .insert(guestCardFacts)
            .values(
              facts.map((f) => ({ ...f, cardId: row.id, addedBy: me.id, source: 'inviter' })),
            );
        }
        return row;
      });
      await writeAuditLog(db, {
        serverId: server.id,
        actorId: me.id,
        category: 'welcome',
        action: 'guest_card.create',
        summary: 'Made a guest card',
        details: { cardId: card.id },
      });
      const [view] = await views([card], me, () => true, request);
      return reply.status(201).send(view);
    },
  );

  fastify.put<{ Params: { cardId: string }; Body: Record<string, unknown> }>(
    '/guest-cards/:cardId',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const card = await ownCard(request.params.cardId, me, reply);
      if (!card) return reply;
      const fields = parseCard({ ...card, ...(request.body ?? {}) });
      if ('error' in fields) return reply.status(400).send({ error: fields.error });
      const facts = parseFacts(request.body?.facts);
      if (facts && 'error' in facts) return reply.status(400).send({ error: facts.error });
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(guestCards)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(guestCards.id, card.id))
          .returning();
        if (facts) {
          // Replace the inviter's own facts; anyone else's stay.
          await tx
            .delete(guestCardFacts)
            .where(
              and(
                eq(guestCardFacts.cardId, card.id),
                eq(guestCardFacts.source, 'inviter'),
                eq(guestCardFacts.addedBy, me.id),
              ),
            );
          if (facts.length) {
            await tx
              .insert(guestCardFacts)
              .values(
                facts.map((f) => ({ ...f, cardId: card.id, addedBy: me.id, source: 'inviter' })),
              );
          }
        }
        return row;
      });
      const [view] = await views([updated], me, () => true, request);
      return view;
    },
  );

  fastify.delete<{ Params: { cardId: string } }>('/guest-cards/:cardId', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return reply;
    const card = await ownCard(request.params.cardId, me, reply);
    if (!card) return reply;
    // Its links stop working with it.
    await db.update(invites).set({ expiresAt: new Date() }).where(eq(invites.guestCardId, card.id));
    await db.delete(guestCards).where(eq(guestCards.id, card.id));
    return { ok: true };
  });

  fastify.post<{ Params: { cardId: string }; Body: { expiresInHours?: unknown } }>(
    '/guest-cards/:cardId/invite',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const card = await ownCard(request.params.cardId, me, reply);
      if (!card) return reply;
      if (!(await hasPermission(db, card.serverId, me.id, PERMISSIONS.CREATE_INVITES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
      const [arrived] = await db
        .select({ id: inviteArrivals.id })
        .from(inviteArrivals)
        .where(eq(inviteArrivals.guestCardId, card.id))
        .limit(1);
      if (arrived) return reply.status(409).send({ error: 'They already joined' });

      const hours = request.body?.expiresInHours;
      const expiresAt =
        typeof hours === 'number' && hours > 0 ? new Date(Date.now() + hours * 3600_000) : null;
      const invite = await db.transaction(async (tx) => {
        // Regenerating replaces the old link.
        await tx
          .update(invites)
          .set({ expiresAt: new Date() })
          .where(
            and(
              eq(invites.guestCardId, card.id),
              or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
            ),
          );
        const [row] = await tx
          .insert(invites)
          .values({
            code: crypto.randomUUID().replace(/-/g, '').slice(0, 8),
            serverId: card.serverId,
            createdBy: me.id,
            maxUses: 1,
            expiresAt,
            guestCardId: card.id,
          })
          .returning();
        return row;
      });
      await writeAuditLog(db, {
        serverId: card.serverId,
        actorId: me.id,
        category: 'server',
        action: 'server.invite_create',
        summary: 'Created invite code from a guest card',
        details: { code: invite.code, cardId: card.id },
      });
      return reply.status(201).send({
        code: invite.code,
        url: `${publicOrigin(fastify.config, request)}/invite/${invite.code}`,
        maxUses: invite.maxUses,
        expiresAt: invite.expiresAt?.toISOString() ?? null,
      });
    },
  );

  async function arrivalViews(me: Actor, pendingOnly: boolean): Promise<ArrivalConsentView[]> {
    const rows = await db
      .select({ arrival: inviteArrivals, card: guestCards, server: actors })
      .from(inviteArrivals)
      .innerJoin(guestCards, eq(guestCards.id, inviteArrivals.guestCardId))
      .innerJoin(actors, eq(actors.id, inviteArrivals.serverId))
      .where(
        and(
          eq(inviteArrivals.actorId, me.id),
          ...(pendingOnly ? [isNull(inviteArrivals.lookupConsent)] : []),
        ),
      );
    const facts = await factsFor(
      db,
      rows.map((r) => r.card.id),
    );
    const withSeeds = rows.filter((r) => needsConsent(r.card, facts));
    const inviterIds = withSeeds.map((r) => r.arrival.invitedById).filter((x): x is string => !!x);
    const inviters = inviterIds.length
      ? await db.select().from(actors).where(inArray(actors.id, inviterIds))
      : [];
    return withSeeds.map((r) => {
      const inviter = inviters.find((i) => i.id === r.arrival.invitedById);
      return {
        id: r.arrival.id,
        server: { id: r.server.id, name: r.server.displayName ?? r.server.preferredUsername },
        invitedBy: inviter ? { name: inviter.displayName ?? inviter.preferredUsername } : null,
        seeds: r.card.seeds ?? '',
        facts: (facts.get(r.card.id) ?? []).map((f) => ({ key: f.key, value: f.value })),
        addedLink: r.arrival.addedLink,
        lookupConsent: r.arrival.lookupConsent,
      };
    });
  }

  fastify.get<{ Querystring: { pending?: string } }>('/me/arrivals', async (request, reply) => {
    const me = requireActor(request, reply);
    if (!me) return reply;
    return arrivalViews(me, request.query.pending === 'true');
  });

  fastify.put<{ Params: { arrivalId: string }; Body: { consent?: unknown; link?: unknown } }>(
    '/me/arrivals/:arrivalId/consent',
    async (request, reply) => {
      const me = requireActor(request, reply);
      if (!me) return reply;
      const { arrivalId } = request.params;
      const consent = request.body?.consent;
      if (typeof consent !== 'boolean') {
        return reply.status(400).send({ error: 'consent (true or false) is required' });
      }
      const link = text(request.body?.link, LIMITS.link, 'link');
      if (link && typeof link === 'object') return reply.status(400).send({ error: link.error });
      if (!UUID_RE.test(arrivalId)) return reply.status(404).send({ error: 'Not found' });
      const [row] = await db
        .update(inviteArrivals)
        .set({
          lookupConsent: consent,
          consentAt: new Date(),
          // A link they add goes with a yes; a no keeps nothing new.
          addedLink: consent ? link : null,
        })
        .where(and(eq(inviteArrivals.id, arrivalId), eq(inviteArrivals.actorId, me.id)))
        .returning();
      if (!row) return reply.status(404).send({ error: 'Not found' });

      await writeAuditLog(db, {
        serverId: row.serverId,
        actorId: me.id,
        category: 'welcome',
        action: consent ? 'arrival.lookup_yes' : 'arrival.lookup_no',
        summary: consent
          ? `@${me.preferredUsername} said the house may look them up`
          : `@${me.preferredUsername} said no thanks to being looked up`,
      });

      // Their welcomers see the answer now.
      const ws = await db
        .select()
        .from(welcomes)
        .where(and(eq(welcomes.serverId, row.serverId), eq(welcomes.newcomerId, me.id)));
      for (const v of await welcomeViews(db, ws)) {
        const w = ws.find((x) => x.id === v.id)!;
        fastify.broadcastToActor(w.welcomerId, {
          type: 'welcome:updated',
          payload: { welcome: v },
        });
      }
      return (await arrivalViews(me, false)).find((a) => a.id === row.id) ?? { ok: true };
    },
  );
}
