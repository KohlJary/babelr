// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageView, AuthorView } from './messages.js';

export type WsServerMessage =
  | { type: 'connected'; payload: { actorId: string } }
  | { type: 'message:new'; payload: { message: MessageView; author: AuthorView } }
  | { type: 'error'; payload: { message: string } };

export type WsClientMessage =
  | { type: 'channel:subscribe'; payload: { channelId: string } }
  | { type: 'channel:unsubscribe'; payload: { channelId: string } };
