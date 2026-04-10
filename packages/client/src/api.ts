// SPDX-License-Identifier: Hippocratic-3.0
import type {
  RegisterInput,
  LoginInput,
  ActorProfile,
  ChannelView,
  ServerView,
  DMConversation,
  MessageView,
  MessageListResponse,
  MessageWithAuthor,
  CreateServerInput,
  CreateChannelInput,
} from '@babelr/shared';

const API_BASE = (typeof window !== 'undefined' && localStorage.getItem('babelr:server-url'))
  ? localStorage.getItem('babelr:server-url')!
  : '/api';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((options?.headers as Record<string, string>) ?? {}) };
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  return res.json();
}

// Auth
export async function register(input: RegisterInput): Promise<ActorProfile> {
  return apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(input) });
}

export async function login(input: LoginInput): Promise<ActorProfile> {
  return apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function getMe(): Promise<ActorProfile> {
  return apiFetch('/auth/me');
}

// Servers
export async function getServers(): Promise<ServerView[]> {
  return apiFetch('/servers');
}

export interface DiscoverableServer extends ServerView {
  joined: boolean;
}

export async function discoverServers(): Promise<DiscoverableServer[]> {
  return apiFetch('/servers/discover');
}

export async function createServer(input: CreateServerInput): Promise<ServerView> {
  return apiFetch('/servers', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateServer(
  serverId: string,
  input: import('@babelr/shared').UpdateServerInput,
): Promise<ServerView> {
  return apiFetch(`/servers/${serverId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function updateChannel(
  channelId: string,
  input: import('@babelr/shared').UpdateChannelInput,
): Promise<import('@babelr/shared').ChannelView> {
  return apiFetch(`/channels/${channelId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function joinServer(serverId: string): Promise<void> {
  await apiFetch(`/servers/${serverId}/join`, { method: 'POST' });
}

export async function leaveServer(serverId: string): Promise<void> {
  await apiFetch(`/servers/${serverId}/leave`, { method: 'POST' });
}

// Channels
export async function getServerChannels(serverId: string): Promise<ChannelView[]> {
  return apiFetch(`/servers/${serverId}/channels`);
}

export async function createChannel(
  serverId: string,
  input: CreateChannelInput,
): Promise<ChannelView> {
  return apiFetch(`/servers/${serverId}/channels`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getMessages(
  channelId: string,
  cursor?: string,
  isDM = false,
): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const prefix = isDM ? '/dms' : '/channels';
  return apiFetch(`${prefix}/${channelId}/messages${qs ? `?${qs}` : ''}`);
}

export async function sendMessage(
  channelId: string,
  content: string,
  isDM = false,
  properties?: Record<string, unknown>,
): Promise<MessageWithAuthor> {
  const prefix = isDM ? '/dms' : '/channels';
  return apiFetch(`${prefix}/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, ...(properties && { properties }) }),
  });
}

// Unread badges
export async function getUnreadCount(channelId: string): Promise<{ count: number }> {
  return apiFetch(`/channels/${channelId}/unread`);
}

export async function markChannelAsRead(channelId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/channels/${channelId}/read`, { method: 'PUT' });
}

// Mentions
export async function getMentions(cursor?: string, limit?: string): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return apiFetch(`/mentions${qs ? `?${qs}` : ''}`);
}

// Threaded replies
export async function getReplies(
  channelId: string,
  messageId: string,
): Promise<MessageListResponse> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/replies`);
}

export async function sendReply(
  channelId: string,
  messageId: string,
  content: string,
): Promise<MessageWithAuthor> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

// Search
export async function searchMessages(
  query: string,
  channelId?: string,
  limit?: string,
): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (channelId) params.set('channelId', channelId);
  if (limit) params.set('limit', limit);
  return apiFetch(`/search?${params.toString()}`);
}

// Reactions
export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

export async function removeReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
}

// Message management
export async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
): Promise<MessageView> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function deleteMessage(
  channelId: string,
  messageId: string,
): Promise<void> {
  await apiFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  });
}

// Server invite management
export interface InviteView {
  code: string;
  url: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export async function listServerInvites(serverId: string): Promise<InviteView[]> {
  return apiFetch(`/servers/${serverId}/invites`);
}

// Threads
export async function getThreadReplies(
  channelId: string,
  messageId: string,
): Promise<MessageListResponse> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/replies`);
}

export async function sendThreadReply(
  channelId: string,
  messageId: string,
  content: string,
): Promise<MessageWithAuthor> {
  return apiFetch(`/channels/${channelId}/messages/${messageId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

// DMs
export async function getDMs(): Promise<DMConversation[]> {
  return apiFetch('/dms');
}

export async function startDM(participantId: string): Promise<DMConversation> {
  return apiFetch('/dms', { method: 'POST', body: JSON.stringify({ participantId }) });
}

export async function getUsers(): Promise<{ id: string; preferredUsername: string; displayName: string | null }[]> {
  return apiFetch('/users');
}

export async function lookupUser(handle: string): Promise<{
  id: string;
  preferredUsername: string;
  displayName: string | null;
  uri: string;
}> {
  return apiFetch('/users/lookup', { method: 'POST', body: JSON.stringify({ handle }) });
}

// Friends
export async function getFriends(): Promise<import('@babelr/shared').FriendshipView[]> {
  return apiFetch('/friends');
}

export async function addFriend(handle: string): Promise<import('@babelr/shared').FriendshipView> {
  return apiFetch('/friends', { method: 'POST', body: JSON.stringify({ handle }) });
}

export async function acceptFriend(
  friendshipId: string,
): Promise<import('@babelr/shared').FriendshipView> {
  return apiFetch(`/friends/${friendshipId}/accept`, { method: 'POST' });
}

export async function removeFriend(friendshipId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/friends/${friendshipId}`, { method: 'DELETE' });
}

// E2E encryption
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch('/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function updateProfile(
  profile: {
    displayName?: string;
    summary?: string;
    avatarUrl?: string;
    preferredLanguage?: string;
  },
): Promise<ActorProfile> {
  return apiFetch('/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
}

export async function setPublicKey(publicKey: JsonWebKey): Promise<void> {
  await apiFetch('/auth/publickey', {
    method: 'PUT',
    body: JSON.stringify({ publicKey }),
  });
}

export async function getUserPublicKey(
  userId: string,
): Promise<{ publicKey: JsonWebKey | null }> {
  return apiFetch(`/users/${userId}/publickey`);
}

// Members
export interface MemberView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
  role: string;
}

export async function getMembers(serverId: string): Promise<MemberView[]> {
  return apiFetch(`/servers/${serverId}/members`);
}

export async function setMemberRole(
  serverId: string,
  userId: string,
  role: string,
): Promise<void> {
  await apiFetch(`/servers/${serverId}/members/${userId}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

export async function kickMember(serverId: string, userId: string): Promise<void> {
  await apiFetch(`/servers/${serverId}/members/${userId}`, {
    method: 'DELETE',
  });
}

// Glossary
export async function getGlossary(channelId: string): Promise<Record<string, string>> {
  const res = await apiFetch<{ glossary: Record<string, string> }>(`/channels/${channelId}/glossary`);
  return res.glossary;
}

export async function updateGlossary(
  channelId: string,
  glossary: Record<string, string>,
): Promise<void> {
  await apiFetch(`/channels/${channelId}/glossary`, {
    method: 'PUT',
    body: JSON.stringify({ glossary }),
  });
}

// Notification preferences
export async function getMutedChannels(): Promise<Record<string, boolean>> {
  const res = await apiFetch<{ muted: Record<string, boolean> }>('/notifications/preferences');
  return res.muted;
}

export async function setMutePreference(
  targetId: string,
  targetType: string,
  muted: boolean,
): Promise<void> {
  await apiFetch('/notifications/preferences', {
    method: 'PUT',
    body: JSON.stringify({ targetId, targetType, muted }),
  });
}

// Channel invites
export async function inviteToChannel(channelId: string, userId: string): Promise<void> {
  await apiFetch(`/channels/${channelId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

// Server invites
export async function createServerInvite(
  serverId: string,
  options?: { maxUses?: number; expiresInHours?: number },
): Promise<{ code: string; url: string }> {
  return apiFetch(`/servers/${serverId}/invites`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
}

export async function joinViaInvite(code: string): Promise<{ ok: boolean; server: { id: string; name: string } }> {
  return apiFetch(`/invites/${code}/join`, { method: 'POST' });
}

export { ApiError };
