// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import { agentReplyStatus } from '../db/schema/agent-reply-status.ts';
import type { AgentReplyState, AgentReplyStatusView, WsServerMessage } from '@babelr/shared';
import { isSponsoredKind } from '../actor-kind.ts';
import { checkDMPost, isDMRow } from '../dm-consent.ts';
import { checkChannelAccess, toAuthorView } from '../serializers.ts';

/**
 * Agent reply status: an agent says, on the message it's answering,
 * that it's working on a reply, that it failed, or that it's done; the
 * message's author can ask it to retry. So a person talking to an agent
 * can see that their message was picked up, and when it wasn't
 * answered, can say "try again" from the message itself.
 *
 * Channels and DMs alike (a DM is a channel row). Statuses ride along
 * on the message list (getMessagesForChannel) and change live over the
 * channel's WS as `agent-status:update`. The detail text is the agent's
 * own, stored and broadcast in plaintext even in an E2E DM, so agents
 * keep it to an error class ("usage limit"), never message content.
 *
 * Agents learn about a retry by reading the message list: their own
 * status on a message turns to `retry`.
 */

const AGENT_STATES: ReadonlySet<string> = new Set(['working', 'failed', 'done']);
/** States a retry may be asked from: a failure, a reply that never
 *  came, or a retry the agent never picked up (asking again is harmless). */
const RETRYABLE: ReadonlySet<string> = new Set(['failed', 'working', 'retry']);
export const MAX_DETAIL = 300;

type Db = FastifyInstance['db'];

/** Status views for these messages, keyed by message id. */
export async function agentStatusFor(
  db: Db,
  messageIds: string[],
): Promise<Map<string, AgentReplyStatusView[]>> {
  const out = new Map<string, AgentReplyStatusView[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({ status: agentReplyStatus, agent: actors })
    .from(agentReplyStatus)
    .innerJoin(actors, eq(agentReplyStatus.agentId, actors.id))
    .where(inArray(agentReplyStatus.objectId, messageIds));
  for (const r of rows) {
    const list = out.get(r.status.objectId) ?? [];
    list.push(toStatusView(r.status, r.agent));
    out.set(r.status.objectId, list);
  }
  return out;
}

function toStatusView(
  row: typeof agentReplyStatus.$inferSelect,
  agent: typeof actors.$inferSelect,
): AgentReplyStatusView {
  return {
    agent: toAuthorView(agent),
    state: row.state as AgentReplyState,
    detail: row.detail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function agentStatusRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  /** The message, if it's a message in a channel this actor can see. */
  async function findMessage(channelId: string, messageId: string) {
    const [message] = await db
      .select()
      .from(objects)
      .where(
        and(eq(objects.id, messageId), eq(objects.context, channelId), eq(objects.type, 'Note')),
      )
      .limit(1);
    return message ?? null;
  }

  async function upsert(
    messageId: string,
    agentId: string,
    state: AgentReplyState,
    detail: string,
  ): Promise<typeof agentReplyStatus.$inferSelect> {
    const now = new Date();
    const [row] = await db
      .insert(agentReplyStatus)
      .values({ objectId: messageId, agentId, state, detail, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentReplyStatus.objectId, agentReplyStatus.agentId],
        set: { state, detail, updatedAt: now },
      })
      .returning();
    return row;
  }

  function broadcast(channelId: string, messageId: string, status: AgentReplyStatusView) {
    const msg: WsServerMessage = { type: 'agent-status:update', payload: { messageId, status } };
    fastify.broadcastToChannel(channelId, msg);
  }

  // An agent reports on a message it's answering.
  fastify.put<{
    Params: { channelId: string; messageId: string };
    Body: { state?: unknown; detail?: unknown };
  }>('/channels/:channelId/messages/:messageId/agent-status', async (request, reply) => {
    const me = request.actor;
    if (!me) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isSponsoredKind(me.kind)) {
      return reply.status(403).send({ error: 'Only agents report reply status' });
    }
    const { channelId, messageId } = request.params;
    const { state, detail = '' } = request.body ?? {};
    if (typeof state !== 'string' || !AGENT_STATES.has(state)) {
      return reply.status(400).send({ error: 'state must be working, failed or done' });
    }
    if (typeof detail !== 'string' || detail.length > MAX_DETAIL) {
      return reply.status(400).send({ error: `detail must be a string up to ${MAX_DETAIL} chars` });
    }

    const { allowed, channel } = await checkChannelAccess(db, channelId, me.uri);
    if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });
    // In a DM, the same consent as a reaction: a blocked or
    // still-requesting agent can't light up someone's messages.
    if (isDMRow(channel)) {
      const decision = await checkDMPost(db, channel, me, 'react');
      if (!decision.ok) return reply.status(decision.status).send({ error: decision.error });
    }
    const message = await findMessage(channelId, messageId);
    if (!message) return reply.status(404).send({ error: 'Message not found' });
    if (message.attributedTo === me.id) {
      return reply.status(400).send({ error: "An agent doesn't answer its own message" });
    }

    const row = await upsert(messageId, me.id, state as AgentReplyState, detail);
    const status = toStatusView(row, me);
    broadcast(channelId, messageId, status);
    return status;
  });

  // The message's author asks an agent to try again. Sessions only:
  // the route isn't in the agent scope map, so no token reaches it.
  fastify.post<{ Params: { channelId: string; messageId: string; agentId: string } }>(
    '/channels/:channelId/messages/:messageId/agent-status/:agentId/retry',
    async (request, reply) => {
      const me = request.actor;
      if (!me) return reply.status(401).send({ error: 'Not authenticated' });
      const { channelId, messageId, agentId } = request.params;
      const { allowed } = await checkChannelAccess(db, channelId, me.uri);
      if (!allowed) return reply.status(403).send({ error: 'Not a member of this channel' });
      const message = await findMessage(channelId, messageId);
      if (!message) return reply.status(404).send({ error: 'Message not found' });
      if (message.attributedTo !== me.id) {
        return reply.status(403).send({ error: 'Only the message’s author can ask for a retry' });
      }
      const [current] = await db
        .select({ status: agentReplyStatus, agent: actors })
        .from(agentReplyStatus)
        .innerJoin(actors, eq(agentReplyStatus.agentId, actors.id))
        .where(and(eq(agentReplyStatus.objectId, messageId), eq(agentReplyStatus.agentId, agentId)))
        .limit(1);
      if (!current) return reply.status(404).send({ error: 'That agent isn’t answering this' });
      if (!RETRYABLE.has(current.status.state)) {
        return reply
          .status(409)
          .send({ error: `Nothing to retry: the reply is ${current.status.state}` });
      }
      const row = await upsert(messageId, agentId, 'retry', '');
      const status = toStatusView(row, current.agent);
      broadcast(channelId, messageId, status);
      return status;
    },
  );
}
