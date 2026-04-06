// SPDX-License-Identifier: Hippocratic-3.0

export interface MessageView {
  id: string;
  content: string;
  channelId: string;
  authorId: string;
  published: string;
  properties?: Record<string, unknown>;
}

export interface AuthorView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
}

export interface ChannelView {
  id: string;
  name: string;
  serverId: string | null;
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
}
