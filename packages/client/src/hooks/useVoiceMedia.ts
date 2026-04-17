// SPDX-License-Identifier: Hippocratic-3.0
import { useRef, useCallback } from 'react';
import type * as mediasoupClient from 'mediasoup-client';
import type { WsServerMessage, WsClientMessage, VoiceSlot } from '@babelr/shared';
import type { UseVoiceState } from './useVoice';

export const PTT_KEY = '`';

export function useVoiceMedia(
  rpc: <T extends WsServerMessage>(build: (requestId: string) => WsClientMessage) => Promise<T>,
  sendTransportRef: React.MutableRefObject<mediasoupClient.types.Transport | null>,
  channelIdRef: React.MutableRefObject<string | null>,
  setState: React.Dispatch<React.SetStateAction<UseVoiceState>>,
) {
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);

  const micProducerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const camProducerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const screenProducerRef = useRef<mediasoupClient.types.Producer | null>(null);

  const pttEnabledRef = useRef(false);
  const pttKeyHeldRef = useRef(false);
  const micMutedRef = useRef(false);
  const deafenedRef = useRef(false);

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

  const toggleMute = useCallback(() => {
    micMutedRef.current = !micMutedRef.current;
    setState((s) => ({ ...s, micMuted: micMutedRef.current }));
    applyMicEnabled();
  }, [applyMicEnabled, setState]);

  const togglePushToTalk = useCallback(() => {
    pttEnabledRef.current = !pttEnabledRef.current;
    setState((s) => ({ ...s, pushToTalk: pttEnabledRef.current }));
    applyMicEnabled();
  }, [applyMicEnabled, setState]);

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
  }, [rpc, sendTransportRef, channelIdRef, setState]);

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
  }, [rpc, sendTransportRef, channelIdRef, setState]);

  const getLocalVideoStream = useCallback(() => localVideoStreamRef.current, []);
  const getLocalScreenStream = useCallback(() => localScreenStreamRef.current, []);

  return {
    localStreamRef,
    localVideoStreamRef,
    localScreenStreamRef,
    micProducerRef,
    camProducerRef,
    screenProducerRef,
    pttEnabledRef,
    pttKeyHeldRef,
    micMutedRef,
    deafenedRef,
    applyMicEnabled,
    toggleMute,
    togglePushToTalk,
    toggleVideo,
    toggleScreenShare,
    getLocalVideoStream,
    getLocalScreenStream,
  };
}
