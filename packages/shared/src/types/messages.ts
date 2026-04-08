// SPDX-License-Identifier: Hippocratic-3.0
import type { PresenceStatus } from './ws.js';

export interface MessageView {
  id: string;
  content: string;
  channelId: string;
  authorId: string;
  published: string;
  updated?: string;
  properties?: Record<string, unknown>;
  inReplyTo?: string;
  replyCount?: number;
  reactions?: Record<string, string[]>;
}

export interface ChannelWithUnread extends ChannelView {
  unreadCount?: number;
}

export interface MentionBadge {
  unreadMentionCount?: number;
}

export interface AuthorView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
  presence?: PresenceStatus;
}

export interface ChannelView {
  id: string;
  name: string;
  serverId: string | null;
  category?: string;
}

export interface ServerView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

export interface DMConversation {
  id: string;
  participants: AuthorView[];
  lastMessage?: MessageView;
}

export interface MessageWithAuthor {
  message: MessageView;
  author: AuthorView;
}

export interface MessageListResponse {
  messages: MessageWithAuthor[];
  hasMore: boolean;
  cursor?: string;
}

export interface CreateMessageInput {
  content: string;
  properties?: Record<string, unknown>;
}

export interface CreateServerInput {
  name: string;
  description?: string;
}

export interface CreateChannelInput {
  name: string;
  category?: string;
}
