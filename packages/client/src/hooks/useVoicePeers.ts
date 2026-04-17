// SPDX-License-Identifier: Hippocratic-3.0
import { useRef, useCallback } from 'react';
import type * as mediasoupClient from 'mediasoup-client';
import type {
  AuthorView,
  WsServerMessage,
  WsClientMessage,
  VoiceSlot,
  SfuConsumerParams,
} from '@babelr/shared';
import type { VoicePeerState, UseVoiceState, PeerEntry } from './useVoice';

const SPEAKING_THRESHOLD = 18;

export function useVoicePeers(
  rpc: <T extends WsServerMessage>(build: (requestId: string) => WsClientMessage) => Promise<T>,
  deviceRef: React.MutableRefObject<mediasoupClient.Device | null>,
  recvTransportRef: React.MutableRefObject<mediasoupClient.types.Transport | null>,
  deafenedRef: React.MutableRefObject<boolean>,
  setState: React.Dispatch<React.SetStateAction<UseVoiceState>>,
) {
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const knownActorsRef = useRef<Map<string, AuthorView>>(new Map());

  const audioCtxRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<{
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    buf: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const speakingRafRef = useRef<number | null>(null);

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
  }, [setState]);

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
  }, [syncPeersToState, setState]);

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
    [deafenedRef],
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
    [ensurePeer, ensureAudioContext, rpc, syncPeersToState, deviceRef, recvTransportRef],
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

  const applyDeafened = useCallback(() => {
    for (const entry of peersRef.current.values()) {
      entry.audioElement.muted = deafenedRef.current;
    }
  }, [deafenedRef]);

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

  const getPeerVideoStream = useCallback((actorId: string) => {
    return peersRef.current.get(actorId)?.videoStream ?? null;
  }, []);
  const getPeerScreenStream = useCallback((actorId: string) => {
    return peersRef.current.get(actorId)?.screenStream ?? null;
  }, []);

  return {
    peersRef,
    knownActorsRef,
    audioCtxRef,
    localAnalyserRef,
    syncPeersToState,
    ensureAudioContext,
    startSpeakingLoop,
    stopSpeakingLoop,
    ensurePeer,
    removePeer,
    consumeProducer,
    handleProducerClosed,
    applyDeafened,
    setPeerVolume,
    getPeerVideoStream,
    getPeerScreenStream,
  };
}
