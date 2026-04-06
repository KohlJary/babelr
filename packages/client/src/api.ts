// SPDX-License-Identifier: Hippocratic-3.0
import type {
  RegisterInput,
  LoginInput,
  ActorProfile,
  ChannelView,
  MessageListResponse,
  MessageWithAuthor,
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

export async function register(input: RegisterInput): Promise<ActorProfile> {
  return apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function login(input: LoginInput): Promise<ActorProfile> {
  return apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function getMe(): Promise<ActorProfile> {
  return apiFetch('/auth/me');
}

export async function getChannels(): Promise<ChannelView[]> {
  return apiFetch('/channels');
}

export async function getMessages(
  channelId: string,
  cursor?: string,
): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return apiFetch(`/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
}

export async function sendMessage(
  channelId: string,
  content: string,
): Promise<MessageWithAuthor> {
  return apiFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export { ApiError };
