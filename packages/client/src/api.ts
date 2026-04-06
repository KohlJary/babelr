// SPDX-License-Identifier: Hippocratic-3.0
import type {
  RegisterInput,
  LoginInput,
  ActorProfile,
  ChannelView,
  ServerView,
  DMConversation,
  MessageListResponse,
  MessageWithAuthor,
  CreateServerInput,
  CreateChannelInput,
} from '@babelr/shared';

const API_BASE = '/api';

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
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
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
): Promise<MessageWithAuthor> {
  const prefix = isDM ? '/dms' : '/channels';
  return apiFetch(`${prefix}/${channelId}/messages`, {
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

export { ApiError };
