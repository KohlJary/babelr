// SPDX-License-Identifier: Hippocratic-3.0
import { eq, and, lt, desc, inArray } from 'drizzle-orm';
import { objects } from './db/schema/objects.ts';
import { actors } from './db/schema/actors.ts';
import { reactions } from './db/schema/reactions.ts';
import { collectionItems } from './db/schema/collections.ts';
import type {
  ChannelView,
  MessageView,
  AuthorView,
  MessageWithAuthor,
  MessageListResponse,
} from '@babelr/shared';

const DEFAULT_LIMIT = 50;

export function toChannelView(obj: typeof objects.$inferSelect): ChannelView {
  const props = obj.properties as Record<string, unknown> | null;
  const channelType = (props?.channelType as 'text' | 'voice' | undefined) ?? 'text';
  return {
    id: obj.id,
    name: (props?.name as string) ?? 'unnamed',
    serverId: obj.belongsTo,
    channelType,
    ...(props?.category ? { category: props.category as string } : {}),
    ...(props?.isPrivate ? { isPrivate: true } : {}),
    ...(props?.topic ? { topic: props.topic as string } : {}),
    ...(props?.description ? { description: props.description as string } : {}),
    ...(typeof props?.slowMode === 'number' && props.slowMode > 0
      ? { slowMode: props.slowMode as number }
      : {}),
    ...(obj.uri ? { uri: obj.uri } : {}),
  };
}

export function toMessageView(
  obj: typeof objects.$inferSelect,
  reactionsData?: Record<string, string[]>,
): MessageView {
  const props = obj.properties as Record<string, unknown> | null;
  const messageProps: Record<string, unknown> = {};
  if (props?.encrypted) messageProps.encrypted = true;
  if (props?.iv) messageProps.iv = props.iv;
  if (props?.attachments) messageProps.attachments = props.attachments;

  return {
    id: obj.id,
    content: obj.content ?? '',
    channelId: obj.context ?? '',
    authorId: obj.attributedTo ?? '',
    slug: obj.slug ?? null,
    published: obj.published.toISOString(),
    ...(obj.updated &&
      obj.updated.getTime() !== obj.published.getTime() && {
        updated: obj.updated.toISOString(),
      }),
    ...(Object.keys(messageProps).length > 0 && { properties: messageProps }),
    ...(reactionsData && { reactions: reactionsData }),
  };
}

export function toAuthorView(
  actor: typeof actors.$inferSelect,
): AuthorView {
  const props = actor.properties as Record<string, unknown> | null;
  return {
    id: actor.id,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    avatarUrl: (props?.avatarUrl as string) ?? null,
    uri: actor.uri,
  };
}

export async function getMessagesForChannel(
  db: ReturnType<typeof import('./db/index.ts').createDb>,
  channelId: string,
  cursor?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<MessageListResponse> {
  const conditions = [eq(objects.context, channelId), eq(objects.type, 'Note')];

  if (cursor) {
    conditions.push(lt(objects.published, new Date(cursor)));
  }

  const rows = await db
    .select({ object: objects, actor: actors })
    .from(objects)
    .innerJoin(actors, eq(objects.attributedTo, actors.id))
    .where(and(...conditions))
    .orderBy(desc(objects.published))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const messageIds = items.map((row) => row.object.id);
  const reactionRows =
    messageIds.length > 0
      ? await db
          .select()
          .from(reactions)
          .where(inArray(reactions.objectId, messageIds))
      : [];

  const reactionsByMessage = new Map<string, Record<string, string[]>>();
  for (const r of reactionRows) {
    const msgReactions = reactionsByMessage.get(r.objectId) ?? {};
    const list = msgReactions[r.emoji] ?? [];
    list.push(r.actorId);
    msgReactions[r.emoji] = list;
    reactionsByMessage.set(r.objectId, msgReactions);
  }

  const messages: MessageWithAuthor[] = items.map((row) => ({
    message: toMessageView(row.object, reactionsByMessage.get(row.object.id)),
    author: toAuthorView(row.actor),
  }));

  const response: MessageListResponse = { messages, hasMore };
  if (hasMore && items.length > 0) {
    response.cursor =
      items[items.length - 1].object.published.toISOString();
  }
  return response;
}

export async function checkChannelAccess(
  db: ReturnType<typeof import('./db/index.ts').createDb>,
  channelId: string,
  actorUri: string,
): Promise<{
  allowed: boolean;
  channel: typeof objects.$inferSelect | null;
}> {
  const [channel] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.id, channelId), eq(objects.type, 'OrderedCollection')))
    .limit(1);

  if (!channel) return { allowed: false, channel: null };
  if (!channel.belongsTo) return { allowed: true, channel };

  const [server] = await db
    .select()
    .from(actors)
    .where(eq(actors.id, channel.belongsTo))
    .limit(1);

  if (!server?.followersUri) return { allowed: false, channel };

  const [membership] = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, server.followersUri),
        eq(collectionItems.itemUri, actorUri),
      ),
    )
    .limit(1);

  if (!membership) return { allowed: false, channel };

  const props = channel.properties as Record<string, unknown> | null;
  if (props?.isPrivate) {
    const [channelMembership] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, channel.uri),
          eq(collectionItems.itemUri, actorUri),
        ),
      )
      .limit(1);
    return { allowed: !!channelMembership, channel };
  }

  return { allowed: true, channel };
}
