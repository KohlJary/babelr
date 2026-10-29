// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { getMessagesForChannel } from '../serializers.ts';
import { createMessageInChannel } from './channels.ts';
import type { DMConversation, CreateMessageInput } from '@babelr/shared';
import { isActorLike, isSponsoredKind } from '../actor-kind.ts';
import { writeAuditLog } from '../audit.ts';
import {
  REFUSED_OPEN,
  acceptRequest,
  blockedEitherWay,
  conversationView,
  createDM,
  createRequest,
  decideOpen,
  dmIdsFor,
  findDepartedDM,
  findSharedDM,
  isDMRow,
  leaveDM,
  pendingIncomingDMIds,
  rejoinDM,
  reopenDeclined,
  requestFor,
} from '../dm-consent.ts';

const DEFAULT_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = typeof actors.$inferSelect;

export default async function dmRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  /** The DM and the caller, if the caller is currently in it. */
  async function loadMyDM(
    request: FastifyRequest<{ Params: { dmId: string } }>,
    reply: FastifyReply,
  ) {
    if (!request.actor) {
      reply.status(401).send({ error: 'Not authenticated' });
      return null;
    }
    const { dmId } = request.params;
    if (!UUID_RE.test(dmId)) {
      reply.status(404).send({ error: 'Conversation not found' });
      return null;
    }
    const [channel] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, dmId), isNull(objects.belongsTo)))
      .limit(1);
    if (!channel) {
      reply.status(404).send({ error: 'Conversation not found' });
      return null;
    }
    const [membership] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, channel.uri),
          eq(collectionItems.itemUri, request.actor.uri),
        ),
      )
      .limit(1);
    if (!membership) {
      reply.status(403).send({ error: 'Not a participant' });
      return null;
    }
    return { me: request.actor, dm: channel };
  }

  function auditAgent(me: Actor, action: string, summary: string, details: object) {
    if (!isSponsoredKind(me.kind)) return Promise.resolve();
    return writeAuditLog(db, {
      serverId: null,
      actorId: me.id,
      sponsorId: me.sponsorId,
      category: 'agent',
      action,
      summary,
      details: details as Record<string, unknown>,
    });
  }

  /**
   * Start a DM, or get the one you already share. The other person's
   * DM policy, allowlist and blocks decide whether this opens a DM,
   * sends a message request, or is refused (403, one neutral message
   * whatever the reason). Someone who left a DM can't be put back in
   * by anyone but themselves.
   */
  fastify.post<{ Body: { participantId: string } }>('/dms', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { participantId } = request.body ?? ({} as { participantId: string });
    if (!participantId || typeof participantId !== 'string') {
      return reply.status(400).send({ error: 'participantId is required' });
    }
    // Unknown ids get the same answer as a refusal, so this route can't
    // be used to learn who exists or what their policy is.
    if (!UUID_RE.test(participantId)) {
      return reply.status(403).send({ error: REFUSED_OPEN });
    }

    const me = request.actor;
    const [other] = await db.select().from(actors).where(eq(actors.id, participantId)).limit(1);

    // People, agents and services; not servers (Group actors).
    if (!other || !isActorLike(other.type)) {
      return reply.status(403).send({ error: REFUSED_OPEN });
    }
    if (other.id === me.id) {
      return reply.status(400).send({ error: 'Cannot DM yourself' });
    }

    // Already in one together.
    const shared = await findSharedDM(db, me, other);
    if (shared) {
      // Opening a DM someone asked you for answers their request.
      const req = await requestFor(db, shared.id);
      if (req && req.toId === me.id && req.state === 'pending') {
        if (await blockedEitherWay(db, me.id, other.id)) {
          return reply.status(403).send({ error: REFUSED_OPEN });
        }
        await acceptRequest(db, req.id);
      }
      return conversationView(db, shared, me);
    }

    // I left one they're still in: coming back is my call alone.
    const mineDeparted = await findDepartedDM(db, me, other);
    const mine = mineDeparted?.dm;
    if (mine) {
      if (await blockedEitherWay(db, me.id, other.id)) {
        return reply.status(403).send({ error: REFUSED_OPEN });
      }
      await rejoinDM(db, mine, me);
      await auditAgent(me, 'dm.rejoin', `@${me.preferredUsername} rejoined a DM`, {
        dmId: mine.id,
      });
      return conversationView(db, mine, me);
    }

    // They left one with me: nobody can put them back. (A declined
    // request is different: after the cooldown I may ask again, in
    // the same conversation, and they can say no again.)
    const theirs = await findDepartedDM(db, other, me);
    if (theirs && theirs.reason !== 'declined') {
      return reply.status(403).send({ error: REFUSED_OPEN });
    }

    const decision = await decideOpen(db, me, other);
    if (decision === 'refuse') {
      // A declined requester gets their conversation back, as before
      // the decline (still "pending"): a 403 here would tell them.
      if (theirs && !(await blockedEitherWay(db, me.id, other.id))) {
        return conversationView(db, theirs.dm, me);
      }
      return reply.status(403).send({ error: REFUSED_OPEN });
    }

    if (theirs) {
      await reopenDeclined(db, theirs.dm, me, other, decision);
      const view = await conversationView(db, theirs.dm, me);
      if (other.local) {
        fastify.broadcastToActor(other.id, {
          type: decision === 'request' ? 'dm:request' : 'conversation:new',
          payload: { conversation: await conversationView(db, theirs.dm, other) },
        });
      }
      return reply.status(201).send(view);
    }

    const dm = await createDM(fastify, me, other);
    if (decision === 'request') await createRequest(db, dm.id, me.id, other.id);
    await auditAgent(me, 'dm.open', `@${me.preferredUsername} opened a DM`, {
      dmId: dm.id,
      with: other.id,
      request: decision === 'request',
    });

    const conversation = await conversationView(db, dm, me);
    if (other.local) {
      fastify.broadcastToActor(other.id, {
        type: decision === 'request' ? 'dm:request' : 'conversation:new',
        payload: { conversation: await conversationView(db, dm, other) },
      });
    }
    return reply.status(201).send(conversation);
  });

  // List DM conversations. Unanswered incoming requests are listed
  // separately, at GET /dms/requests.
  fastify.get('/dms', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const me = request.actor;
    const pending = new Set(await pendingIncomingDMIds(db, me));
    const conversations: DMConversation[] = [];
    for (const id of await dmIdsFor(db, me)) {
      if (pending.has(id)) continue;
      const [dm] = await db.select().from(objects).where(eq(objects.id, id)).limit(1);
      if (isDMRow(dm)) conversations.push(await conversationView(db, dm, me));
    }

    // Sort by last message time (most recent first)
    conversations.sort((a, b) => {
      const aTime = a.lastMessage?.published ?? '';
      const bTime = b.lastMessage?.published ?? '';
      return bTime.localeCompare(aTime);
    });

    return conversations;
  });

  // Message requests waiting for my answer.
  fastify.get('/dms/requests', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const me = request.actor;
    const out: DMConversation[] = [];
    for (const id of await pendingIncomingDMIds(db, me)) {
      const [dm] = await db.select().from(objects).where(eq(objects.id, id)).limit(1);
      if (isDMRow(dm)) out.push(await conversationView(db, dm, me));
    }
    return out;
  });

  fastify.post<{ Params: { dmId: string } }>(
    '/dms/:dmId/request/accept',
    async (request, reply) => {
      const ctx = await loadMyDM(request, reply);
      if (!ctx) return reply;
      const { me, dm } = ctx;
      const req = await requestFor(db, dm.id);
      if (!req || req.toId !== me.id || req.state !== 'pending') {
        return reply.status(404).send({ error: 'No request to answer' });
      }
      if (await blockedEitherWay(db, me.id, req.fromId)) {
        return reply.status(403).send({ error: REFUSED_OPEN });
      }
      await acceptRequest(db, req.id);
      await auditAgent(me, 'dm.request.accept', `@${me.preferredUsername} accepted a request`, {
        dmId: dm.id,
        from: req.fromId,
      });
      return conversationView(db, dm, me);
    },
  );

  // Declining is quiet: the requester isn't told, can't send more, and
  // can't ask again until the cooldown ends.
  fastify.post<{ Params: { dmId: string } }>(
    '/dms/:dmId/request/decline',
    async (request, reply) => {
      const ctx = await loadMyDM(request, reply);
      if (!ctx) return reply;
      const { me, dm } = ctx;
      const req = await requestFor(db, dm.id);
      if (!req || req.toId !== me.id || req.state !== 'pending') {
        return reply.status(404).send({ error: 'No request to answer' });
      }
      await leaveDM(fastify, dm, me, 'declined');
      return { ok: true };
    },
  );

  /**
   * Leave a DM. Anyone in it can, agents included, with any token: the
   * route needs no scope, so a sponsor can't take leaving away. The
   * leaver stops receiving it and the others see "left". Only the
   * leaver can come back (POST /dms with the same person).
   */
  fastify.post<{ Params: { dmId: string } }>('/dms/:dmId/leave', async (request, reply) => {
    const ctx = await loadMyDM(request, reply);
    if (!ctx) return reply;
    await leaveDM(fastify, ctx.dm, ctx.me, 'left');
    return { ok: true };
  });

  // Get DM messages
  fastify.get<{
    Params: { dmId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/dms/:dmId/messages', async (request, reply) => {
    const ctx = await loadMyDM(request, reply);
    if (!ctx) return reply;
    const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);
    return getMessagesForChannel(db, ctx.dm.id, request.query.cursor, limit);
  });

  // Send DM message. The consent check (requests, blocks, everyone
  // gone) runs inside createMessageInChannel, for every path that
  // writes into a DM.
  fastify.post<{
    Params: { dmId: string };
    Body: CreateMessageInput;
  }>('/dms/:dmId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const { content } = request.body ?? ({} as CreateMessageInput);
    if (!content || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Message content is required' });
    }
    const ctx = await loadMyDM(request, reply);
    if (!ctx) return reply;

    const { properties } = request.body;
    const result = await createMessageInChannel(fastify, ctx.dm.id, content, ctx.me, properties);
    return reply.status(201).send(result);
  });
}
