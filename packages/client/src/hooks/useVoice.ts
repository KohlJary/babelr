// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useCallback } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import type {
  AuthorView,
  WsServerMessage,
  WsClientMessage,
  VoiceSlot,
  SfuConsumerParams,
} from '@babelr/shared';

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

interface PeerEntry {
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

const SPEAKING_THRESHOLD = 18;
const PTT_KEY = '`';
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

interface PendingRequest {
  resolve: (msg: WsServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

  const wsRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const micProducerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const camProducerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const screenProducerRef = useRef<mediasoupClient.types.Producer | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<{
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    buf: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const speakingRafRef = useRef<number | null>(null);

  const pttEnabledRef = useRef(false);
  const pttKeyHeldRef = useRef(false);
  const micMutedRef = useRef(false);
  const deafenedRef = useRef(false);

  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const knownActorsRef = useRef<Map<string, AuthorView>>(new Map());
  const channelIdRef = useRef<string | null>(null);

  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const requestSeqRef = useRef(0);

  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const newRequestId = useCallback(() => {
    requestSeqRef.current += 1;
    return `r${requestSeqRef.current}`;
  }, []);

  /**
   * Send a WS request and resolve when the matching response (or
   * voice:request-error with the same requestId) arrives. The handlers
   * for transport-created / transport-connected / produced / consumed /
   * consumer-resumed / producer-closed-ack all dispatch through this map.
   */
  const rpc = useCallback(
    <T extends WsServerMessage>(
      build: (requestId: string) => WsClientMessage,
    ): Promise<T> => {
      const requestId = newRequestId();
      const msg = build(requestId);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error(`voice rpc timeout: ${msg.type}`));
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(requestId, {
          resolve: (m) => resolve(m as T),
          reject,
          timer,
        });
        sendWs(msg);
      });
    },
    [newRequestId, sendWs],
  );

  const syncPeersToState = useCallback(() => {
    const arr: VoicePeerState[] = [];
    for (const [actorId, entry] of peersRef.current) {
      arr.push({
        actorId,
        actor: entry.actor,
        connected: entry.audioConsumer !== null,
        speaking: entry.speaking,
        volume: entry.volume,
        hasVideo: entry.videoStream !== null,
        hasScreen: entry.screenStream !== null,
      });
    }
    setState((s) => ({ ...s, peers: arr }));
  }, []);

  const applyMicEnabled = useCallback(() => {
    const producer = micProducerRef.current;
    if (!producer) return;
    const allowed =
      !micMutedRef.current &&
      !deafenedRef.current &&
      (!pttEnabledRef.current || pttKeyHeldRef.current);
    // Pause vs resume on the producer is the SFU equivalent of
    // track.enabled: it stops RTP from being forwarded server-side.
    if (allowed && producer.paused) producer.resume();
    else if (!allowed && !producer.paused) producer.pause();
  }, []);

  const applyDeafened = useCallback(() => {
    for (const entry of peersRef.current.values()) {
      entry.audioElement.muted = deafenedRef.current;
    }
  }, []);

  const ensureAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    // Browsers suspend AudioContexts created without a recent user gesture.
    // join() runs inside a click handler so this resume should succeed.
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {
        // ignore — analyser will silently no-op until user interacts
      });
    }
    return audioCtxRef.current;
  }, []);

  const startSpeakingLoop = useCallback(() => {
    if (speakingRafRef.current !== null) return;
    const tick = () => {
      let stateDirty = false;
      // Local mic
      const local = localAnalyserRef.current;
      if (local) {
        local.analyser.getByteFrequencyData(local.buf);
        let sum = 0;
        for (let i = 0; i < local.buf.length; i++) sum += local.buf[i];
        const avg = sum / local.buf.length;
        const speakingNow = avg > SPEAKING_THRESHOLD;
        setState((s) =>
          s.localSpeaking === speakingNow ? s : { ...s, localSpeaking: speakingNow },
        );
      }
      // Remote peers
      for (const entry of peersRef.current.values()) {
        if (!entry.analyser || !entry.analyserBuf) continue;
        entry.analyser.getByteFrequencyData(entry.analyserBuf);
        let sum = 0;
        for (let i = 0; i < entry.analyserBuf.length; i++) sum += entry.analyserBuf[i];
        const avg = sum / entry.analyserBuf.length;
        const speakingNow = avg > SPEAKING_THRESHOLD;
        if (speakingNow !== entry.speaking) {
          entry.speaking = speakingNow;
          stateDirty = true;
        }
      }
      if (stateDirty) syncPeersToState();
      speakingRafRef.current = requestAnimationFrame(tick);
    };
    speakingRafRef.current = requestAnimationFrame(tick);
  }, [syncPeersToState]);

  const stopSpeakingLoop = useCallback(() => {
    if (speakingRafRef.current !== null) {
      cancelAnimationFrame(speakingRafRef.current);
      speakingRafRef.current = null;
    }
  }, []);

  const ensurePeer = useCallback(
    (actorId: string, hint?: AuthorView): PeerEntry => {
      let entry = peersRef.current.get(actorId);
      if (entry) return entry;
      const actor: AuthorView =
        hint ??
        knownActorsRef.current.get(actorId) ?? {
          id: actorId,
          preferredUsername: actorId,
          displayName: null,
        };
      const audioElement = new Audio();
      audioElement.autoplay = true;
      audioElement.muted = deafenedRef.current;
      // Detached <audio> elements get stricter autoplay treatment in
      // some browsers. Attach hidden to keep playback reliable.
      audioElement.style.display = 'none';
      document.body.appendChild(audioElement);
      entry = {
        actor,
        audioConsumer: null,
        audioElement,
        audioStream: null,
        videoConsumer: null,
        videoStream: null,
        screenConsumer: null,
        screenStream: null,
        analyser: null,
        analyserBuf: null,
        speaking: false,
        volume: 1,
      };
      peersRef.current.set(actorId, entry);
      return entry;
    },
    [],
  );

  const removePeer = useCallback(
    (actorId: string) => {
      const entry = peersRef.current.get(actorId);
      if (!entry) return;
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
      peersRef.current.delete(actorId);
      syncPeersToState();
    },
    [syncPeersToState],
  );

  const consumeProducer = useCallback(
    async (
      channelId: string,
      peerActorId: string,
      producerId: string,
      slot: VoiceSlot,
    ) => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) return;
      try {
        const reply = await rpc<Extract<WsServerMessage, { type: 'voice:consumed' }>>(
          (requestId) => ({
            type: 'voice:consume',
            payload: {
              requestId,
              channelId,
              transportId: recvTransport.id,
              producerId,
              rtpCapabilities: device.recvRtpCapabilities,
            },
          }),
        );
        const params: SfuConsumerParams = reply.payload.consumer;
        const consumer = await recvTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters as mediasoupClient.types.RtpParameters,
        });
        // Server creates the consumer paused; resume after the client side
        // is wired up so we don't drop the first packets.
        await rpc<Extract<WsServerMessage, { type: 'voice:consumer-resumed' }>>(
          (requestId) => ({
            type: 'voice:resume-consumer',
            payload: { requestId, channelId, consumerId: consumer.id },
          }),
        );

        const entry = ensurePeer(peerActorId);
        const stream = new MediaStream([consumer.track]);
        if (slot === 'mic') {
          entry.audioConsumer?.close();
          entry.audioConsumer = consumer;
          entry.audioStream = stream;
          entry.audioElement.srcObject = stream;
          entry.audioElement.play().catch((err) => {
            console.warn('[voice] audio.play rejected (autoplay policy?):', err);
          });
          // Wire up speaking analyser
          try {
            const ctx = ensureAudioContext();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            entry.analyser = analyser;
            entry.analyserBuf = new Uint8Array(analyser.frequencyBinCount);
          } catch {
            // analyser failure shouldn't break audio
          }
        } else if (slot === 'cam') {
          entry.videoConsumer?.close();
          entry.videoConsumer = consumer;
          entry.videoStream = stream;
        } else if (slot === 'screen') {
          entry.screenConsumer?.close();
          entry.screenConsumer = consumer;
          entry.screenStream = stream;
        }
        consumer.on('transportclose', () => {
          if (slot === 'mic') entry.audioConsumer = null;
          else if (slot === 'cam') {
            entry.videoConsumer = null;
            entry.videoStream = null;
          } else {
            entry.screenConsumer = null;
            entry.screenStream = null;
          }
          syncPeersToState();
        });
        syncPeersToState();
      } catch (err) {
        console.warn('voice: consume failed', { peerActorId, producerId, slot, err });
      }
    },
    [ensurePeer, ensureAudioContext, rpc, syncPeersToState],
  );

  const handleProducerClosed = useCallback(
    (peerActorId: string, producerId: string) => {
      const entry = peersRef.current.get(peerActorId);
      if (!entry) return;
      let dirty = false;
      if (entry.audioConsumer?.producerId === producerId) {
        entry.audioConsumer.close();
        entry.audioConsumer = null;
        entry.audioStream = null;
        try {
          entry.audioElement.srcObject = null;
        } catch {
          // ignore
        }
        entry.analyser = null;
        entry.analyserBuf = null;
        dirty = true;
      }
      if (entry.videoConsumer?.producerId === producerId) {
        entry.videoConsumer.close();
        entry.videoConsumer = null;
        entry.videoStream = null;
        dirty = true;
      }
      if (entry.screenConsumer?.producerId === producerId) {
        entry.screenConsumer.close();
        entry.screenConsumer = null;
        entry.screenStream = null;
        dirty = true;
      }
      if (dirty) syncPeersToState();
    },
    [syncPeersToState],
  );

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
      peersRef.current.clear();
      knownActorsRef.current.clear();

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
      localStreamRef.current = stream;

      // Local analyser for speaking indicator.
      try {
        const ctx = ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        localAnalyserRef.current = {
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
              knownActorsRef.current.set(p.id, p);
              ensurePeer(p.id, p);
            }
            syncPeersToState();
            break;
          case 'voice:participant-joined': {
            knownActorsRef.current.set(msg.payload.participant.id, msg.payload.participant);
            ensurePeer(msg.payload.participant.id, msg.payload.participant);
            syncPeersToState();
            break;
          }
          case 'voice:participant-left':
            removePeer(msg.payload.actorId);
            break;
          case 'voice:new-producer': {
            const { producer } = msg.payload;
            if (producer.peerActorId === selfActorId) break;
            const ch = channelIdRef.current;
            if (!ch) break;
            void consumeProducer(ch, producer.peerActorId, producer.producerId, producer.slot);
            break;
          }
          case 'voice:producer-closed':
            handleProducerClosed(msg.payload.peerActorId, msg.payload.producerId);
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
        micProducerRef.current = micProducer;
      }

      // 5) Subscribe to existing producers
      for (const peer of joinedMsg.payload.peers) {
        ensurePeer(peer.actorId);
        for (const prod of peer.producers) {
          await consumeProducer(channelId, peer.actorId, prod.producerId, prod.slot);
        }
      }

      startSpeakingLoop();
      setState((s) => ({ ...s, status: 'connected' }));
      applyMicEnabled();
    },
    [
      applyMicEnabled,
      consumeProducer,
      ensureAudioContext,
      ensurePeer,
      handleProducerClosed,
      removePeer,
      rpc,
      selfActorId,
      sendWs,
      startSpeakingLoop,
      syncPeersToState,
    ],
  );

  const teardown = useCallback(() => {
    stopSpeakingLoop();
    micProducerRef.current?.close();
    camProducerRef.current?.close();
    screenProducerRef.current?.close();
    micProducerRef.current = null;
    camProducerRef.current = null;
    screenProducerRef.current = null;
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    deviceRef.current = null;

    for (const entry of peersRef.current.values()) {
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
    peersRef.current.clear();
    knownActorsRef.current.clear();

    if (localAnalyserRef.current) {
      try {
        localAnalyserRef.current.source.disconnect();
      } catch {
        // ignore
      }
      localAnalyserRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    for (const stream of [
      localStreamRef.current,
      localVideoStreamRef.current,
      localScreenStreamRef.current,
    ]) {
      if (stream) for (const t of stream.getTracks()) t.stop();
    }
    localStreamRef.current = null;
    localVideoStreamRef.current = null;
    localScreenStreamRef.current = null;

    for (const pending of pendingRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('voice teardown'));
    }
    pendingRef.current.clear();
  }, [stopSpeakingLoop]);

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
  }, [sendWs, teardown]);

  const toggleMute = useCallback(() => {
    micMutedRef.current = !micMutedRef.current;
    setState((s) => ({ ...s, micMuted: micMutedRef.current }));
    applyMicEnabled();
  }, [applyMicEnabled]);

  const toggleDeafen = useCallback(() => {
    deafenedRef.current = !deafenedRef.current;
    setState((s) => ({ ...s, deafened: deafenedRef.current }));
    applyDeafened();
    applyMicEnabled();
  }, [applyDeafened, applyMicEnabled]);

  const togglePushToTalk = useCallback(() => {
    pttEnabledRef.current = !pttEnabledRef.current;
    setState((s) => ({ ...s, pushToTalk: pttEnabledRef.current }));
    applyMicEnabled();
  }, [applyMicEnabled]);

  const setPeerVolume = useCallback(
    (actorId: string, volume: number) => {
      const entry = peersRef.current.get(actorId);
      if (!entry) return;
      entry.volume = Math.max(0, Math.min(1, volume));
      entry.audioElement.volume = entry.volume;
      syncPeersToState();
    },
    [syncPeersToState],
  );

  const toggleVideo = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const channelId = channelIdRef.current;
    if (!sendTransport || !channelId) return;
    const existing = camProducerRef.current;
    if (existing) {
      const id = existing.id;
      existing.close();
      camProducerRef.current = null;
      if (localVideoStreamRef.current) {
        for (const t of localVideoStreamRef.current.getTracks()) t.stop();
        localVideoStreamRef.current = null;
      }
      // Server cleans up the producer when its transport sees the close
      // through the standard lifecycle, but we explicitly close-broadcast
      // so peers drop the consumer immediately rather than waiting for
      // SCTP-level signaling.
      await rpc<Extract<WsServerMessage, { type: 'voice:producer-closed-ack' }>>(
        (requestId) => ({
          type: 'voice:close-producer',
          payload: { requestId, channelId, producerId: id },
        }),
      ).catch(() => {
        // best-effort
      });
      setState((s) => ({ ...s, videoEnabled: false }));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      localVideoStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no video track');
      const producer = await sendTransport.produce({
        track,
        encodings: [
          { maxBitrate: 100_000 },
          { maxBitrate: 300_000 },
          { maxBitrate: 900_000 },
        ],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { slot: 'cam' as VoiceSlot },
      });
      camProducerRef.current = producer;
      setState((s) => ({ ...s, videoEnabled: true }));
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
    }
  }, [rpc]);

  const toggleScreenShare = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const channelId = channelIdRef.current;
    if (!sendTransport || !channelId) return;
    const existing = screenProducerRef.current;
    if (existing) {
      const id = existing.id;
      existing.close();
      screenProducerRef.current = null;
      if (localScreenStreamRef.current) {
        for (const t of localScreenStreamRef.current.getTracks()) t.stop();
        localScreenStreamRef.current = null;
      }
      await rpc<Extract<WsServerMessage, { type: 'voice:producer-closed-ack' }>>(
        (requestId) => ({
          type: 'voice:close-producer',
          payload: { requestId, channelId, producerId: id },
        }),
      ).catch(() => {});
      setState((s) => ({ ...s, screenShareEnabled: false }));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      localScreenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no screen track');
      const producer = await sendTransport.produce({
        track,
        encodings: [{ maxBitrate: 1_500_000 }],
        appData: { slot: 'screen' as VoiceSlot },
      });
      screenProducerRef.current = producer;
      // If the user picks "Stop sharing" via the browser UI, the track ends.
      track.addEventListener('ended', () => {
        if (screenProducerRef.current?.id === producer.id) {
          void toggleScreenShare();
        }
      });
      setState((s) => ({ ...s, screenShareEnabled: true }));
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
    }
  }, [rpc]);

  const getLocalVideoStream = useCallback(() => localVideoStreamRef.current, []);
  const getLocalScreenStream = useCallback(() => localScreenStreamRef.current, []);
  const getPeerVideoStream = useCallback((actorId: string) => {
    return peersRef.current.get(actorId)?.videoStream ?? null;
  }, []);
  const getPeerScreenStream = useCallback((actorId: string) => {
    return peersRef.current.get(actorId)?.screenStream ?? null;
  }, []);

  // Push-to-talk key listeners.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (!pttEnabledRef.current) return;
      pttKeyHeldRef.current = true;
      applyMicEnabled();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (!pttEnabledRef.current) return;
      pttKeyHeldRef.current = false;
      applyMicEnabled();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [applyMicEnabled]);

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
    toggleMute,
    toggleDeafen,
    togglePushToTalk,
    setPeerVolume,
    toggleVideo,
    getLocalVideoStream,
    getPeerVideoStream,
    toggleScreenShare,
    getLocalScreenStream,
    getPeerScreenStream,
  };
}
