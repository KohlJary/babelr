// SPDX-License-Identifier: MIT
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
  /** Agents answering this message, and how that's going. Absent when none. */
  agentStatus?: AgentReplyStatusView[];
  /**
   * Short copy-paste-friendly slug. Used to reference this message
   * from other messages or wiki pages via `[[msg:slug]]` which
   * renders as an inline embed. Present for all server-channel
   * messages. Null/undefined for older messages pre-slug migration.
   */
  slug?: string | null;
}

/**
 * An agent's progress answering one message, set by the agent itself
 * (PUT .../agent-status). `retry` is set by the message's author
 * (POST .../agent-status/:agentId/retry) and is the agent's cue to try
 * again. `done` is kept so the agent can see a retry it already
 * answered; clients show nothing for it.
 */
export type AgentReplyState = 'working' | 'failed' | 'retry' | 'done';

export interface AgentReplyStatusView {
  agent: AuthorView;
  state: AgentReplyState;
  /** The agent's own short note, e.g. why it failed. */
  detail: string;
  updatedAt: string;
}

/**
 * Compact shape returned by the message-lookup-by-slug endpoint.
 * Used by the `<MessageEmbed>` component to render inline previews
 * of referenced messages. Includes enough context (channel + server
 * name) for a reader to decide whether to click through.
 */
export interface MessageEmbedView {
  id: string;
  slug: string;
  content: string;
  channelId: string;
  channelName: string | null;
  serverId: string | null;
  serverName: string | null;
  author: AuthorView;
  published: string;
  updated?: string;
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
  /** Present only for agents and services (never for people). Set by
   *  the server from the actor row; clients can't claim it. */
  kind?: 'agent' | 'service';
}

/**
 * Server-stamped provenance in `MessageView.properties` for messages
 * written by an agent or service. Clients can't set these keys: the
 * server drops them from what clients send and stamps them itself.
 */
export interface MessageProvenance {
  authorKind?: 'agent' | 'service';
  sponsor?: { id: string; preferredUsername: string };
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
  /**
   * ActivityPub URI for this channel. Present for federated voice
   * channels so the client can detect remote ownership and route the
   * federation handshake. Local channels usually omit this.
   */
  uri?: string;
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
  /** Anyone may join without an invite. Off by default. */
  isPublic?: boolean;
}

export interface UpdateServerInput {
  name?: string;
  description?: string | null;
  tagline?: string | null;
  longDescription?: string | null;
  logoUrl?: string | null;
  tags?: string[];
  isPublic?: boolean;
}

export interface DMConversation {
  id: string;
  participants: AuthorView[];
  lastMessage?: MessageView;
  /** Map of actorUri → ISO timestamp of last read position (federated read receipts) */
  readBy?: Record<string, string>;
  /** Participants who left. They no longer receive this conversation. */
  left?: AuthorView[];
  /** Present when the conversation started as a message request.
   *  `incoming` is true for the person who has to accept it. */
  request?: { state: 'pending' | 'accepted'; incoming: boolean };
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
