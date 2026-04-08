// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageView, AuthorView } from './messages.js';

export type PresenceStatus = 'online' | 'away' | 'offline';

export type WsServerMessage =
  | { type: 'connected'; payload: { actorId: string } }
  | { type: 'message:new'; payload: { message: MessageView; author: AuthorView } }
  | { type: 'typing:start'; payload: { channelId: string; actor: AuthorView } }
  | { type: 'presence:update'; payload: { actorId: string; status: PresenceStatus } }
  | { type: 'reaction:add'; payload: { messageId: string; emoji: string; actor: AuthorView } }
  | { type: 'reaction:remove'; payload: { messageId: string; emoji: string; actorId: string } }
  | { type: 'error'; payload: { message: string } };

export type WsClientMessage =
  | { type: 'channel:subscribe'; payload: { channelId: string } }
  | { type: 'channel:unsubscribe'; payload: { channelId: string } }
  | { type: 'typing:start'; payload: { channelId: string } }
  | { type: 'presence:heartbeat'; payload: Record<string, never> };
