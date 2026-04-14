// SPDX-License-Identifier: Hippocratic-3.0
import { cpus } from 'node:os';
import * as mediasoup from 'mediasoup';
import type {
  Worker,
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  RtpCodecCapability,
  RtpCapabilities,
  DtlsParameters,
  RtpParameters,
} from 'mediasoup/types';
import type { Config } from '../config.ts';
import type { VoiceSlot } from '@babelr/shared';

/**
 * Mediasoup SFU. One worker pool per process; one router per voice channel
 * (room); per-participant send + recv WebRtcTransports; producers/consumers
 * tracked by participant so we can close them cleanly on leave.
 */

// preferredPayloadType intentionally omitted — mediasoup assigns from its
// built-in table. Hard-coding values collides with reserved entries.
const MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
] as unknown as RtpCodecCapability[];

interface ParticipantState {
  actorId: string;
  sendTransport?: WebRtcTransport;
  recvTransport?: WebRtcTransport;
  producers: Map<string, { producer: Producer; slot: VoiceSlot }>;
  consumers: Map<string, Consumer>;
}

interface Room {
  router: Router;
  participants: Map<string, ParticipantState>;
}

let workers: Worker[] = [];
let nextWorkerIndex = 0;
let initialized = false;
let cfg: Config | null = null;
const rooms = new Map<string, Room>();

export async function initSfu(config: Config): Promise<void> {
  if (initialized) return;
  cfg = config;
  const workerCount = Math.max(1, Math.min(cpus().length, 4));
  for (let i = 0; i < workerCount; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: config.mediasoupRtcMinPort,
      rtcMaxPort: config.mediasoupRtcMaxPort,
    });
    worker.on('died', () => {
      // Mediasoup workers should never die; surface loudly if they do.
      // A fresh worker isn't spun up automatically — process restart is
      // the safer recovery path.
      console.error(`[sfu] worker ${worker.pid} died`);
    });
    workers.push(worker);
  }
  initialized = true;
}

export async function shutdownSfu(): Promise<void> {
  for (const room of rooms.values()) {
    room.router.close();
  }
  rooms.clear();
  for (const w of workers) w.close();
  workers = [];
  initialized = false;
  cfg = null;
}

function pickWorker(): Worker {
  if (workers.length === 0) {
    throw new Error('SFU not initialized');
  }
  const w = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return w;
}

async function ensureRoom(channelId: string): Promise<Room> {
  let room = rooms.get(channelId);
  if (room) return room;
  const worker = pickWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  room = { router, participants: new Map() };
  rooms.set(channelId, room);
  return room;
}

function getRoom(channelId: string): Room | undefined {
  return rooms.get(channelId);
}

function ensureParticipant(room: Room, actorId: string): ParticipantState {
  let p = room.participants.get(actorId);
  if (!p) {
    p = { actorId, producers: new Map(), consumers: new Map() };
    room.participants.set(actorId, p);
  }
  return p;
}

export function getRouterRtpCapabilities(channelId: string): RtpCapabilities | null {
  const room = rooms.get(channelId);
  return room ? room.router.rtpCapabilities : null;
}

export interface RoomPeerSnapshot {
  actorId: string;
  producers: Array<{ producerId: string; kind: 'audio' | 'video'; slot: VoiceSlot }>;
}

export async function joinRoom(
  channelId: string,
  actorId: string,
): Promise<{ rtpCapabilities: RtpCapabilities; peers: RoomPeerSnapshot[] }> {
  const room = await ensureRoom(channelId);
  ensureParticipant(room, actorId);
  const peers: RoomPeerSnapshot[] = [];
  for (const [pid, p] of room.participants) {
    if (pid === actorId) continue;
    peers.push({
      actorId: pid,
      producers: Array.from(p.producers.values()).map(({ producer, slot }) => ({
        producerId: producer.id,
        kind: producer.kind,
        slot,
      })),
    });
  }
  return { rtpCapabilities: room.router.rtpCapabilities, peers };
}

export async function createTransport(
  channelId: string,
  actorId: string,
  direction: 'send' | 'recv',
): Promise<{
  id: string;
  iceParameters: WebRtcTransport['iceParameters'];
  iceCandidates: WebRtcTransport['iceCandidates'];
  dtlsParameters: WebRtcTransport['dtlsParameters'];
}> {
  if (!cfg) throw new Error('SFU not initialized');
  const room = getRoom(channelId);
  if (!room) throw new Error('Room not found');
  const p = ensureParticipant(room, actorId);

  // UDP-only on purpose. Firefox + mediasoup ICE-Lite + TCP candidates
  // can deadlock because Firefox sometimes pairs TCP first and never
  // falls back. UDP-only sidesteps this and matches typical voice
  // production setups (TCP is a fallback for hostile NAT, not the
  // primary path).
  const transport = await room.router.createWebRtcTransport({
    listenInfos: [
      {
        protocol: 'udp',
        ip: cfg.mediasoupListenIp,
        announcedAddress: cfg.mediasoupAnnouncedIp,
      },
    ],
    enableUdp: true,
    enableTcp: false,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });

  if (direction === 'send') {
    p.sendTransport?.close();
    p.sendTransport = transport;
  } else {
    p.recvTransport?.close();
    p.recvTransport = transport;
  }

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

export async function connectTransport(
  channelId: string,
  actorId: string,
  transportId: string,
  dtlsParameters: DtlsParameters,
): Promise<void> {
  const transport = findTransport(channelId, actorId, transportId);
  await transport.connect({ dtlsParameters });
}

export async function produce(
  channelId: string,
  actorId: string,
  transportId: string,
  kind: 'audio' | 'video',
  rtpParameters: RtpParameters,
  slot: VoiceSlot,
): Promise<{ producerId: string }> {
  const room = getRoom(channelId);
  if (!room) throw new Error('Room not found');
  const p = ensureParticipant(room, actorId);
  const transport = findTransport(channelId, actorId, transportId);
  if (transport !== p.sendTransport) {
    throw new Error('Transport is not a send transport for this actor');
  }
  const producer = await transport.produce({ kind, rtpParameters, appData: { slot } });
  p.producers.set(producer.id, { producer, slot });
  producer.on('transportclose', () => {
    p.producers.delete(producer.id);
  });
  return { producerId: producer.id };
}

export async function consume(
  channelId: string,
  actorId: string,
  transportId: string,
  producerId: string,
  rtpCapabilities: RtpCapabilities,
): Promise<{
  consumerId: string;
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  peerActorId: string;
  slot: VoiceSlot;
}> {
  const room = getRoom(channelId);
  if (!room) throw new Error('Room not found');
  const p = ensureParticipant(room, actorId);
  const transport = findTransport(channelId, actorId, transportId);
  if (transport !== p.recvTransport) {
    throw new Error('Transport is not a recv transport for this actor');
  }
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Cannot consume producer with given capabilities');
  }
  const ownerEntry = findProducerOwner(room, producerId);
  if (!ownerEntry) throw new Error('Producer not found');
  const { ownerActorId, slot } = ownerEntry;

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true,
  });
  p.consumers.set(consumer.id, consumer);
  consumer.on('transportclose', () => {
    p.consumers.delete(consumer.id);
  });
  consumer.on('producerclose', () => {
    p.consumers.delete(consumer.id);
  });

  return {
    consumerId: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    peerActorId: ownerActorId,
    slot,
  };
}

export async function resumeConsumer(
  channelId: string,
  actorId: string,
  consumerId: string,
): Promise<void> {
  const room = getRoom(channelId);
  if (!room) throw new Error('Room not found');
  const p = room.participants.get(actorId);
  const consumer = p?.consumers.get(consumerId);
  if (!consumer) throw new Error('Consumer not found');
  await consumer.resume();
}

export interface ClosedProducerInfo {
  producerId: string;
}

export function closeProducer(
  channelId: string,
  actorId: string,
  producerId: string,
): ClosedProducerInfo | null {
  const room = getRoom(channelId);
  if (!room) return null;
  const p = room.participants.get(actorId);
  const entry = p?.producers.get(producerId);
  if (!entry || !p) return null;
  entry.producer.close();
  p.producers.delete(producerId);
  return { producerId };
}

/**
 * Tear down all of a participant's transports/producers/consumers.
 * Returns the list of producer IDs that were closed so the caller can
 * notify other peers.
 */
export function leaveRoom(channelId: string, actorId: string): string[] {
  const room = rooms.get(channelId);
  if (!room) return [];
  const p = room.participants.get(actorId);
  if (!p) return [];
  const closedProducerIds = Array.from(p.producers.keys());
  for (const { producer } of p.producers.values()) producer.close();
  for (const consumer of p.consumers.values()) consumer.close();
  p.sendTransport?.close();
  p.recvTransport?.close();
  room.participants.delete(actorId);
  if (room.participants.size === 0) {
    room.router.close();
    rooms.delete(channelId);
  }
  return closedProducerIds;
}

function findTransport(
  channelId: string,
  actorId: string,
  transportId: string,
): WebRtcTransport {
  const room = getRoom(channelId);
  if (!room) throw new Error('Room not found');
  const p = room.participants.get(actorId);
  if (!p) throw new Error('Participant not in room');
  if (p.sendTransport?.id === transportId) return p.sendTransport;
  if (p.recvTransport?.id === transportId) return p.recvTransport;
  throw new Error('Transport not found for this participant');
}

function findProducerOwner(
  room: Room,
  producerId: string,
): { ownerActorId: string; slot: VoiceSlot } | null {
  for (const [actorId, p] of room.participants) {
    const entry = p.producers.get(producerId);
    if (entry) return { ownerActorId: actorId, slot: entry.slot };
  }
  return null;
}
