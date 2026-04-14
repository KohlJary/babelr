// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageView, AuthorView, DMConversation } from './messages.js';
import type { FriendshipView } from './friends.js';

export type PresenceStatus = 'online' | 'away' | 'offline';

/**
 * SFU signaling. Track slot is passed via appData so server + clients can
 * tell mic / cam / screen apart without inspecting RTP payload types.
 */
export type VoiceSlot = 'mic' | 'cam' | 'screen';
export type VoiceTransportDirection = 'send' | 'recv';

export interface SfuRtpCapabilities {
  // mediasoup RtpCapabilities — opaque to non-mediasoup consumers
  codecs?: unknown[];
  headerExtensions?: unknown[];
  fecMechanisms?: unknown[];
}

export interface SfuTransportParams {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
  sctpParameters?: unknown;
}

export interface SfuProducerInfo {
  peerActorId: string;
  producerId: string;
  kind: 'audio' | 'video';
  slot: VoiceSlot;
}

export interface SfuConsumerParams {
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: unknown;
  peerActorId: string;
  slot: VoiceSlot;
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
  | { type: 'wiki:page-changed'; payload: { serverId: string; action: 'created' | 'updated' | 'deleted'; slug: string } }
  | { type: 'server:updated'; payload: { serverId: string } }
  | { type: 'voice:room-state'; payload: { channelId: string; participants: AuthorView[] } }
  | { type: 'voice:participant-joined'; payload: { channelId: string; participant: AuthorView } }
  | { type: 'voice:participant-left'; payload: { channelId: string; actorId: string } }
  | { type: 'voice:full'; payload: { channelId: string; max: number } }
  | {
      type: 'voice:joined';
      payload: {
        channelId: string;
        routerRtpCapabilities: SfuRtpCapabilities;
        peers: Array<{ actorId: string; producers: SfuProducerInfo[] }>;
      };
    }
  | {
      type: 'voice:transport-created';
      payload: {
        requestId: string;
        direction: VoiceTransportDirection;
        params: SfuTransportParams;
      };
    }
  | { type: 'voice:transport-connected'; payload: { requestId: string } }
  | { type: 'voice:produced'; payload: { requestId: string; producerId: string } }
  | {
      type: 'voice:consumed';
      payload: { requestId: string; consumer: SfuConsumerParams };
    }
  | { type: 'voice:consumer-resumed'; payload: { requestId: string } }
  | { type: 'voice:producer-closed-ack'; payload: { requestId: string } }
  | {
      type: 'voice:new-producer';
      payload: { channelId: string; producer: SfuProducerInfo };
    }
  | {
      type: 'voice:producer-closed';
      payload: { channelId: string; peerActorId: string; producerId: string };
    }
  | {
      type: 'voice:request-error';
      payload: { requestId: string; message: string };
    }
  | { type: 'error'; payload: { message: string } };

export type WsClientMessage =
  | { type: 'channel:subscribe'; payload: { channelId: string } }
  | { type: 'channel:unsubscribe'; payload: { channelId: string } }
  | { type: 'typing:start'; payload: { channelId: string } }
  | { type: 'presence:heartbeat'; payload: Record<string, never> }
  | { type: 'voice:join'; payload: { channelId: string } }
  | { type: 'voice:leave'; payload: { channelId: string } }
  | {
      type: 'voice:create-transport';
      payload: {
        requestId: string;
        channelId: string;
        direction: VoiceTransportDirection;
      };
    }
  | {
      type: 'voice:connect-transport';
      payload: {
        requestId: string;
        channelId: string;
        transportId: string;
        dtlsParameters: unknown;
      };
    }
  | {
      type: 'voice:produce';
      payload: {
        requestId: string;
        channelId: string;
        transportId: string;
        kind: 'audio' | 'video';
        rtpParameters: unknown;
        slot: VoiceSlot;
      };
    }
  | {
      type: 'voice:consume';
      payload: {
        requestId: string;
        channelId: string;
        transportId: string;
        producerId: string;
        rtpCapabilities: SfuRtpCapabilities;
      };
    }
  | {
      type: 'voice:resume-consumer';
      payload: { requestId: string; channelId: string; consumerId: string };
    }
  | {
      type: 'voice:close-producer';
      payload: { requestId: string; channelId: string; producerId: string };
    };
