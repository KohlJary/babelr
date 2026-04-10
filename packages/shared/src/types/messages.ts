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
  avatarUrl?: string | null;
  presence?: PresenceStatus;
  /** ActivityPub actor URI — used for federated identity matching */
  uri?: string;
}

export type ChannelType = 'text' | 'voice';

export interface ChannelView {
  id: string;
  name: string;
  serverId: string | null;
  category?: string;
  isPrivate?: boolean;
  /** 'text' (default) or 'voice' */
  channelType?: ChannelType;
  /** One-line topic shown in the channel header */
  topic?: string | null;
  /** Longer description (markdown permitted) */
  description?: string | null;
  /** Minimum seconds between messages per user (0 = off) */
  slowMode?: number;
}

export interface UpdateChannelInput {
  name?: string;
  category?: string | null;
  topic?: string | null;
  description?: string | null;
  slowMode?: number;
}

export interface ServerView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** Short one-liner shown on discovery cards */
  tagline?: string | null;
  /** Long-form description / welcome text (markdown permitted) */
  longDescription?: string | null;
  /** Server logo/icon URL */
  logoUrl?: string | null;
  /** Freeform tags for discoverability */
  tags?: string[];
}

export interface UpdateServerInput {
  name?: string;
  description?: string | null;
  tagline?: string | null;
  longDescription?: string | null;
  logoUrl?: string | null;
  tags?: string[];
}

export interface DMConversation {
  id: string;
  participants: AuthorView[];
  lastMessage?: MessageView;
  /** Map of actorUri → ISO timestamp of last read position (federated read receipts) */
  readBy?: Record<string, string>;
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
  isPrivate?: boolean;
  channelType?: ChannelType;
}
