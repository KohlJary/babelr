// SPDX-License-Identifier: Hippocratic-3.0

export interface MessageView {
  id: string;
  content: string;
  channelId: string;
  authorId: string;
  published: string;
}

export interface AuthorView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
}

export interface ChannelView {
  id: string;
  name: string;
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
}
