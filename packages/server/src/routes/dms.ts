// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, isNull } from 'drizzle-orm';
import '../types.ts';
import { objects } from '../db/schema/objects.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import {
  toAuthorView,
  toMessageView,
  getMessagesForChannel,
  createMessageInChannel,
} from './channels.ts';
import type { DMConversation, CreateMessageInput } from '@babelr/shared';

const DEFAULT_LIMIT = 50;

async function getDMParticipants(
  db: ReturnType<typeof import('../db/index.ts').createDb>,
  dmUri: string,
) {
  const items = await db
    .select({ actor: actors })
    .from(collectionItems)
    .innerJoin(actors, eq(collectionItems.itemId, actors.id))
    .where(eq(collectionItems.collectionUri, dmUri));

  return items.map((i) => toAuthorView(i.actor));
}

async function getLastMessage(
  db: ReturnType<typeof import('../db/index.ts').createDb>,
  channelId: string,
) {
  const [row] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.context, channelId), eq(objects.type, 'Note')))
    .orderBy(desc(objects.published))
    .limit(1);

  return row ? toMessageView(row) : undefined;
}

export default async function dmRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  // Start or get existing DM
  fastify.post<{ Body: { participantId: string } }>('/dms', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { participantId } = request.body;
    if (!participantId) {
      return reply.status(400).send({ error: 'participantId is required' });
    }

    const actor = request.actor;

    // Find the other participant
    const [other] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, participantId))
      .limit(1);

    if (!other) {
      return reply.status(404).send({ error: 'User not found' });
    }

    if (other.id === actor.id) {
      return reply.status(400).send({ error: 'Cannot DM yourself' });
    }

    // Check if a DM already exists between these two users
    // Find DM channels where actor is a participant
    const myDMs = await db
      .select({ collectionUri: collectionItems.collectionUri })
      .from(collectionItems)
      .where(eq(collectionItems.itemUri, actor.uri));

    for (const dm of myDMs) {
      // Check if the other user is also in this collection
      const [otherInDM] = await db
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, dm.collectionUri),
            eq(collectionItems.itemUri, other.uri),
          ),
        )
        .limit(1);

      if (otherInDM) {
        // Verify it's actually a DM channel (not a server follower list)
        const [channel] = await db
          .select()
          .from(objects)
          .where(and(eq(objects.uri, dm.collectionUri), isNull(objects.belongsTo)))
          .limit(1);

        if (channel) {
          const props = channel.properties as Record<string, unknown> | null;
          if (props?.isDM) {
            const participants = await getDMParticipants(db, channel.uri);
            const lastMessage = await getLastMessage(db, channel.id);
            const readBy = (props as Record<string, unknown>)?.readBy as
              | Record<string, string>
              | undefined;
            const conversation: DMConversation = {
              id: channel.id,
              participants,
              lastMessage,
              ...(readBy ? { readBy } : {}),
            };
            return conversation;
          }
        }
      }
    }

    // No existing DM — create one
    const dmUri = `${protocol}://${config.domain}/dms/${crypto.randomUUID()}`;

    const [channel] = await db
      .insert(objects)
      .values({
        uri: dmUri,
        type: 'OrderedCollection',
        belongsTo: null,
        properties: { name: null, isDM: true },
      })
      .returning();

    // Add both participants
    await db.insert(collectionItems).values([
      {
        collectionUri: channel.uri,
        collectionId: channel.id,
        itemUri: actor.uri,
        itemId: actor.id,
      },
      {
        collectionUri: channel.uri,
        collectionId: channel.id,
        itemUri: other.uri,
        itemId: other.id,
      },
    ]);

    const participants = [toAuthorView(actor), toAuthorView(other)];
    const conversation: DMConversation = { id: channel.id, participants };
    return reply.status(201).send(conversation);
  });

  // List DM conversations
  fastify.get('/dms', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const actor = request.actor;

    // Find all collections the user is in
    const myItems = await db
      .select({
        collectionUri: collectionItems.collectionUri,
        collectionId: collectionItems.collectionId,
      })
      .from(collectionItems)
      .where(eq(collectionItems.itemUri, actor.uri));

    const conversations: DMConversation[] = [];

    for (const item of myItems) {
      if (!item.collectionId) continue;

      // Check if it's a DM channel
      const [channel] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, item.collectionId), isNull(objects.belongsTo)))
        .limit(1);

      if (!channel) continue;
      const props = channel.properties as Record<string, unknown> | null;
      if (!props?.isDM) continue;

      const participants = await getDMParticipants(db, channel.uri);
      const lastMessage = await getLastMessage(db, channel.id);
      const readBy = (props as Record<string, unknown>)?.readBy as
        | Record<string, string>
        | undefined;
      conversations.push({
        id: channel.id,
        participants,
        lastMessage,
        ...(readBy ? { readBy } : {}),
      });
    }

    // Sort by last message time (most recent first)
    conversations.sort((a, b) => {
      const aTime = a.lastMessage?.published ?? '';
      const bTime = b.lastMessage?.published ?? '';
      return bTime.localeCompare(aTime);
    });

    return conversations;
  });

  // Get DM messages
  fastify.get<{
    Params: { dmId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/dms/:dmId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { dmId } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10), 100);

    // Verify DM exists and actor is a participant
    const [channel] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, dmId), isNull(objects.belongsTo)))
      .limit(1);

    if (!channel) return reply.status(404).send({ error: 'Conversation not found' });

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

    if (!membership) return reply.status(403).send({ error: 'Not a participant' });

    return getMessagesForChannel(db, dmId, request.query.cursor, limit);
  });

  // Send DM message
  fastify.post<{
    Params: { dmId: string };
    Body: CreateMessageInput;
  }>('/dms/:dmId/messages', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { dmId } = request.params;
    const { content } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.status(400).send({ error: 'Message content is required' });
    }

    // Verify DM exists and actor is a participant
    const [channel] = await db
      .select()
      .from(objects)
      .where(and(eq(objects.id, dmId), isNull(objects.belongsTo)))
      .limit(1);

    if (!channel) return reply.status(404).send({ error: 'Conversation not found' });

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

    if (!membership) return reply.status(403).send({ error: 'Not a participant' });

    const { properties } = request.body;
    const result = await createMessageInChannel(fastify, dmId, content, request.actor, properties);
    return reply.status(201).send(result);
  });
}
