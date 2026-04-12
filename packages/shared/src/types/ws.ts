// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageView, AuthorView, DMConversation } from './messages.js';
import type { FriendshipView } from './friends.js';

export type PresenceStatus = 'online' | 'away' | 'offline';

/**
 * Voice channel signaling. Audio flows peer-to-peer via WebRTC; the server
 * only relays SDP offers/answers and ICE candidates between participants.
 */
export interface VoiceSdpPayload {
  channelId: string;
  fromActorId: string;
  toActorId: string;
  sdp: string;
}

export interface VoiceIcePayload {
  channelId: string;
  fromActorId: string;
  toActorId: string;
  candidate: RTCIceCandidateInit;
}

export type WsServerMessage =
  | { type: 'connected'; payload: { actorId: string } }
  | { type: 'message:new'; payload: { message: MessageView; author: AuthorView } }
  | { type: 'message:updated'; payload: { messageId: string; channelId: string; content: string; updatedAt: string } }
  | { type: 'message:deleted'; payload: { messageId: string; channelId: string } }
  | { type: 'typing:start'; payload: { channelId: string; actor: AuthorView } }
  | { type: 'presence:update'; payload: { actorId: string; status: PresenceStatus } }
  | { type: 'reaction:add'; payload: { messageId: string; emoji: string; actor: AuthorView } }
  | { type: 'reaction:remove'; payload: { messageId: string; emoji: string; actorId: string } }
  | { type: 'conversation:new'; payload: { conversation: DMConversation } }
  | { type: 'dm:read'; payload: { dmId: string; actorUri: string; lastReadAt: string } }
  | { type: 'friend:request'; payload: { friendship: FriendshipView } }
  | { type: 'friend:accepted'; payload: { friendship: FriendshipView } }
  | { type: 'friend:removed'; payload: { friendshipId: string } }
  | { type: 'friend:updated'; payload: { friendship: FriendshipView } }
  | { type: 'voice:room-state'; payload: { channelId: string; participants: AuthorView[] } }
  | { type: 'voice:participant-joined'; payload: { channelId: string; participant: AuthorView } }
  | { type: 'voice:participant-left'; payload: { channelId: string; actorId: string } }
  | { type: 'voice:offer'; payload: VoiceSdpPayload }
  | { type: 'voice:answer'; payload: VoiceSdpPayload }
  | { type: 'voice:ice'; payload: VoiceIcePayload }
  | { type: 'voice:full'; payload: { channelId: string; max: number } }
  | { type: 'error'; payload: { message: string } };

export type WsClientMessage =
  | { type: 'channel:subscribe'; payload: { channelId: string } }
  | { type: 'channel:unsubscribe'; payload: { channelId: string } }
  | { type: 'typing:start'; payload: { channelId: string } }
  | { type: 'presence:heartbeat'; payload: Record<string, never> }
  | { type: 'voice:join'; payload: { channelId: string } }
  | { type: 'voice:leave'; payload: { channelId: string } }
  | { type: 'voice:offer'; payload: { channelId: string; toActorId: string; sdp: string } }
  | { type: 'voice:answer'; payload: { channelId: string; toActorId: string; sdp: string } }
  | { type: 'voice:ice'; payload: { channelId: string; toActorId: string; candidate: RTCIceCandidateInit } };
