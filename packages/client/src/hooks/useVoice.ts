// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useCallback } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import type {
  AuthorView,
  WsServerMessage,
  VoiceSlot,
} from '@babelr/shared';
import { useVoiceRpc } from './useVoiceRpc';
import { useVoiceMedia, PTT_KEY } from './useVoiceMedia';
import { useVoicePeers } from './useVoicePeers';

export interface VoicePeerState {
  actorId: string;
  actor: AuthorView;
  connected: boolean;
  speaking: boolean;
  volume: number;
  hasVideo: boolean;
  hasScreen: boolean;
}

export interface UseVoiceState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  channelId: string | null;
  peers: VoicePeerState[];
  micMuted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  localSpeaking: boolean;
  videoEnabled: boolean;
  screenShareEnabled: boolean;
}

export interface PeerEntry {
  actor: AuthorView;
  audioConsumer: mediasoupClient.types.Consumer | null;
  audioElement: HTMLAudioElement;
  audioStream: MediaStream | null;
  videoConsumer: mediasoupClient.types.Consumer | null;
  videoStream: MediaStream | null;
  screenConsumer: mediasoupClient.types.Consumer | null;
  screenStream: MediaStream | null;
  analyser: AnalyserNode | null;
  analyserBuf: Uint8Array<ArrayBuffer> | null;
  speaking: boolean;
  volume: number;
}

const REQUEST_TIMEOUT_MS = 10_000;

const IDLE_STATE: UseVoiceState = {
  status: 'idle',
  error: null,
  channelId: null,
  peers: [],
  micMuted: false,
  deafened: false,
  pushToTalk: false,
  localSpeaking: false,
  videoEnabled: false,
  screenShareEnabled: false,
};

/**
 * Voice channel hook backed by a mediasoup SFU. Each client maintains
 * exactly one PeerConnection-equivalent pair (send + recv WebRtcTransport)
 * with the server; the server forwards RTP between participants. Track
 * lifecycle is producer-per-slot (mic / cam / screen): closing a producer
 * tears down delivery to every consumer in the room without renegotiation
 * gymnastics on this side.
 */
export function useVoice(selfActorId: string) {
  const [state, setState] = useState<UseVoiceState>(IDLE_STATE);

  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const channelIdRef = useRef<string | null>(null);

  // --- Sub-hooks ---
  const { wsRef, sendWs, rpc, pendingRef } = useVoiceRpc();

  const media = useVoiceMedia(rpc, sendTransportRef, channelIdRef, setState);

  const peers = useVoicePeers(
    rpc,
    deviceRef,
    recvTransportRef,
    media.deafenedRef,
    setState,
  );

  // --- Orchestrated toggleDeafen (needs both media + peers) ---
  const toggleDeafen = useCallback(() => {
    media.deafenedRef.current = !media.deafenedRef.current;
    setState((s) => ({ ...s, deafened: media.deafenedRef.current }));
    peers.applyDeafened();
    media.applyMicEnabled();
  }, [media, peers, setState]);

  // --- Join ---
  const join = useCallback(
    async (channelIdInput: string, channelUri?: string) => {
      if (channelIdRef.current === channelIdInput) return;
      if (channelIdRef.current) {
        // Switching channels: leave the previous one cleanly first.
        sendWs({ type: 'voice:leave', payload: { channelId: channelIdRef.current } });
      }
      setState({ ...IDLE_STATE, status: 'connecting', channelId: channelIdInput });
      // For federated joins this gets overwritten with the origin
      // Tower's id (which differs from the home cache's id).
      let channelId = channelIdInput;
      channelIdRef.current = channelId;
      peers.peersRef.current.clear();
      peers.knownActorsRef.current.clear();

      // Detect federated voice: if the channel URI's hostname doesn't
      // match this Tower, request a JWT from our home Tower (which
      // signs the federated request) and connect the WS directly to
      // the origin Tower with the JWT. The origin's response also
      // contains the channel id as known on that Tower — use it,
      // since URI UUIDs and row ids are independently generated.
      let wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
      if (channelUri) {
        try {
          const uriHost = new URL(channelUri).hostname;
          if (uriHost && uriHost !== location.hostname) {
            const tokenResp = await fetch('/api/voice/request-federation-token', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channelUri }),
            });
            if (!tokenResp.ok) {
              const errText = await tokenResp.text().catch(() => 'token request failed');
              throw new Error(`federation token: ${errText}`);
            }
            const tokenData = (await tokenResp.json()) as {
              token: string;
              wsUrl: string;
              channelId: string;
              expiresIn: number;
            };
            wsUrl = `${tokenData.wsUrl}?token=${encodeURIComponent(tokenData.token)}`;
            channelId = tokenData.channelId;
            channelIdRef.current = channelId;
            setState((s) => ({ ...s, channelId }));
          }
        } catch (err) {
          setState({
            ...IDLE_STATE,
            status: 'error',
            channelId: null,
            error: `federation: ${(err as Error).message}`,
          });
          channelIdRef.current = null;
          return;
        }
      }

      // 1) Mic
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        setState({
          ...IDLE_STATE,
          status: 'error',
          channelId: null,
          error: (err as Error).message,
        });
        channelIdRef.current = null;
        return;
      }
      media.localStreamRef.current = stream;

      // Local analyser for speaking indicator.
      try {
        const ctx = peers.ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        peers.localAnalyserRef.current = {
          analyser,
          source,
          buf: new Uint8Array(analyser.frequencyBinCount),
        };
      } catch {
        // ignore
      }

      // 2) Open WS (to either local /ws or remote Tower with federation token)
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Routing of all incoming messages happens here. Request/response
      // pairs match by requestId; the rest are broadcasts.
      ws.addEventListener('message', (ev) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(ev.data) as WsServerMessage;
        } catch {
          return;
        }
        // Resolve pending RPCs first
        const payload = (msg as { payload?: { requestId?: string } }).payload;
        const requestId = payload?.requestId;
        if (requestId) {
          const pending = pendingRef.current.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRef.current.delete(requestId);
            if (msg.type === 'voice:request-error') {
              pending.reject(new Error(msg.payload.message));
            } else {
              pending.resolve(msg);
            }
            return;
          }
        }
        switch (msg.type) {
          case 'voice:joined':
            // Handled inline below — kept here so the route doesn't fall
            // through to the participant handlers.
            break;
          case 'voice:room-state':
            for (const p of msg.payload.participants) {
              peers.knownActorsRef.current.set(p.id, p);
              peers.ensurePeer(p.id, p);
            }
            peers.syncPeersToState();
            break;
          case 'voice:participant-joined': {
            peers.knownActorsRef.current.set(msg.payload.participant.id, msg.payload.participant);
            peers.ensurePeer(msg.payload.participant.id, msg.payload.participant);
            peers.syncPeersToState();
            break;
          }
          case 'voice:participant-left':
            peers.removePeer(msg.payload.actorId);
            break;
          case 'voice:new-producer': {
            const { producer } = msg.payload;
            if (producer.peerActorId === selfActorId) break;
            const ch = channelIdRef.current;
            if (!ch) break;
            void peers.consumeProducer(ch, producer.peerActorId, producer.producerId, producer.slot);
            break;
          }
          case 'voice:producer-closed':
            peers.handleProducerClosed(msg.payload.peerActorId, msg.payload.producerId);
            break;
          case 'voice:full':
            setState((s) => ({
              ...s,
              status: 'error',
              error: `Voice channel is full (max ${msg.payload.max})`,
            }));
            break;
          case 'error':
            setState((s) => ({ ...s, status: 'error', error: msg.payload.message }));
            break;
        }
      });

      const waitForOpen = new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.OPEN) resolve();
        else ws.addEventListener('open', () => resolve(), { once: true });
      });
      await waitForOpen;

      // Wait for the SFU bootstrap (router caps + existing producers).
      const joinedMsg = await new Promise<
        Extract<WsServerMessage, { type: 'voice:joined' }>
      >((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.removeEventListener('message', onMsg);
          reject(new Error('voice:joined timeout'));
        }, REQUEST_TIMEOUT_MS);
        const onMsg = (ev: MessageEvent) => {
          try {
            const m = JSON.parse(ev.data) as WsServerMessage;
            if (m.type === 'voice:joined') {
              clearTimeout(timer);
              ws.removeEventListener('message', onMsg);
              resolve(m);
            }
          } catch {
            // ignore
          }
        };
        ws.addEventListener('message', onMsg);
        sendWs({ type: 'voice:join', payload: { channelId } });
      });

      // 3) Device + transports
      const device = new mediasoupClient.Device();
      await device.load({
        routerRtpCapabilities:
          joinedMsg.payload.routerRtpCapabilities as mediasoupClient.types.RtpCapabilities,
      });
      deviceRef.current = device;

      const sendParams = await rpc<
        Extract<WsServerMessage, { type: 'voice:transport-created' }>
      >((requestId) => ({
        type: 'voice:create-transport',
        payload: { requestId, channelId, direction: 'send' },
      }));
      const sendTransport = device.createSendTransport({
        ...(sendParams.payload.params as unknown as mediasoupClient.types.TransportOptions),
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      sendTransportRef.current = sendTransport;
      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        rpc<Extract<WsServerMessage, { type: 'voice:transport-connected' }>>(
          (requestId) => ({
            type: 'voice:connect-transport',
            payload: {
              requestId,
              channelId,
              transportId: sendTransport.id,
              dtlsParameters,
            },
          }),
        )
          .then(() => callback())
          .catch((err: Error) => errback(err));
      });
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const slot = (appData as { slot?: VoiceSlot }).slot ?? 'mic';
        rpc<Extract<WsServerMessage, { type: 'voice:produced' }>>((requestId) => ({
          type: 'voice:produce',
          payload: {
            requestId,
            channelId,
            transportId: sendTransport.id,
            kind,
            rtpParameters,
            slot,
          },
        }))
          .then((reply) => callback({ id: reply.payload.producerId }))
          .catch((err: Error) => errback(err));
      });

      const recvParams = await rpc<
        Extract<WsServerMessage, { type: 'voice:transport-created' }>
      >((requestId) => ({
        type: 'voice:create-transport',
        payload: { requestId, channelId, direction: 'recv' },
      }));
      const recvTransport = device.createRecvTransport({
        ...(recvParams.payload.params as unknown as mediasoupClient.types.TransportOptions),
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      recvTransportRef.current = recvTransport;
      recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        rpc<Extract<WsServerMessage, { type: 'voice:transport-connected' }>>(
          (requestId) => ({
            type: 'voice:connect-transport',
            payload: {
              requestId,
              channelId,
              transportId: recvTransport.id,
              dtlsParameters,
            },
          }),
        )
          .then(() => callback())
          .catch((err: Error) => errback(err));
      });

      // 4) Produce mic
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const micProducer = await sendTransport.produce({
          track: audioTrack,
          appData: { slot: 'mic' as VoiceSlot },
        });
        media.micProducerRef.current = micProducer;
      }

      // 5) Subscribe to existing producers
      for (const peer of joinedMsg.payload.peers) {
        peers.ensurePeer(peer.actorId);
        for (const prod of peer.producers) {
          await peers.consumeProducer(channelId, peer.actorId, prod.producerId, prod.slot);
        }
      }

      peers.startSpeakingLoop();
      setState((s) => ({ ...s, status: 'connected' }));
      media.applyMicEnabled();
    },
    [
      media,
      peers,
      rpc,
      selfActorId,
      sendWs,
      wsRef,
      pendingRef,
    ],
  );

  // --- Teardown ---
  const teardown = useCallback(() => {
    peers.stopSpeakingLoop();
    media.micProducerRef.current?.close();
    media.camProducerRef.current?.close();
    media.screenProducerRef.current?.close();
    media.micProducerRef.current = null;
    media.camProducerRef.current = null;
    media.screenProducerRef.current = null;
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    deviceRef.current = null;

    for (const entry of peers.peersRef.current.values()) {
      entry.audioConsumer?.close();
      entry.videoConsumer?.close();
      entry.screenConsumer?.close();
      try {
        entry.audioElement.pause();
        entry.audioElement.srcObject = null;
        entry.audioElement.remove();
      } catch {
        // ignore
      }
    }
    peers.peersRef.current.clear();
    peers.knownActorsRef.current.clear();

    if (peers.localAnalyserRef.current) {
      try {
        peers.localAnalyserRef.current.source.disconnect();
      } catch {
        // ignore
      }
      peers.localAnalyserRef.current = null;
    }
    if (peers.audioCtxRef.current) {
      peers.audioCtxRef.current.close().catch(() => {});
      peers.audioCtxRef.current = null;
    }

    for (const stream of [
      media.localStreamRef.current,
      media.localVideoStreamRef.current,
      media.localScreenStreamRef.current,
    ]) {
      if (stream) for (const t of stream.getTracks()) t.stop();
    }
    media.localStreamRef.current = null;
    media.localVideoStreamRef.current = null;
    media.localScreenStreamRef.current = null;

    for (const pending of pendingRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('voice teardown'));
    }
    pendingRef.current.clear();
  }, [media, peers, pendingRef]);

  // --- Leave ---
  const leave = useCallback(() => {
    const ch = channelIdRef.current;
    if (ch) {
      sendWs({ type: 'voice:leave', payload: { channelId: ch } });
    }
    teardown();
    wsRef.current?.close();
    wsRef.current = null;
    channelIdRef.current = null;
    setState(IDLE_STATE);
  }, [sendWs, teardown, wsRef]);

  // Push-to-talk key listeners.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (!media.pttEnabledRef.current) return;
      media.pttKeyHeldRef.current = true;
      media.applyMicEnabled();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (!media.pttEnabledRef.current) return;
      media.pttKeyHeldRef.current = false;
      media.applyMicEnabled();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [media]);

  // Hook unmount cleanup.
  useEffect(() => {
    return () => {
      if (channelIdRef.current) {
        sendWs({ type: 'voice:leave', payload: { channelId: channelIdRef.current } });
      }
      teardown();
      wsRef.current?.close();
      wsRef.current = null;
      channelIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    join,
    leave,
    toggleMute: media.toggleMute,
    toggleDeafen,
    togglePushToTalk: media.togglePushToTalk,
    setPeerVolume: peers.setPeerVolume,
    toggleVideo: media.toggleVideo,
    getLocalVideoStream: media.getLocalVideoStream,
    getPeerVideoStream: peers.getPeerVideoStream,
    toggleScreenShare: media.toggleScreenShare,
    getLocalScreenStream: media.getLocalScreenStream,
    getPeerScreenStream: peers.getPeerScreenStream,
  };
}
