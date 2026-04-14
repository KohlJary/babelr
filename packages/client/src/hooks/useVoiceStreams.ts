// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { UseVoiceState } from './useVoice';

interface VoiceStreamGetters {
  getLocalVideoStream: () => MediaStream | null;
  getLocalScreenStream: () => MediaStream | null;
  getPeerVideoStream: (actorId: string) => MediaStream | null;
  getPeerScreenStream: (actorId: string) => MediaStream | null;
}

/**
 * Snapshot the imperative MediaStream getters from useVoice into React
 * state so consumer components re-render when streams change. The
 * useVoice hook keeps streams as refs (because MediaStream identity
 * doesn't carry useful change info for React); the discrete state
 * flags (videoEnabled/screenShareEnabled per self, hasVideo/hasScreen
 * per peer) tell us when to re-snapshot.
 */
export function useVoiceStreams(
  voice: UseVoiceState,
  getters: VoiceStreamGetters,
) {
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [peerVideoStreams, setPeerVideoStreams] = useState<Map<string, MediaStream | null>>(
    new Map(),
  );
  const [peerScreenStreams, setPeerScreenStreams] = useState<Map<string, MediaStream | null>>(
    new Map(),
  );

  useEffect(() => {
    setLocalVideoStream(getters.getLocalVideoStream());
  }, [voice.videoEnabled, getters.getLocalVideoStream]);

  useEffect(() => {
    setLocalScreenStream(getters.getLocalScreenStream());
  }, [voice.screenShareEnabled, getters.getLocalScreenStream]);

  useEffect(() => {
    const vNext = new Map<string, MediaStream | null>();
    const sNext = new Map<string, MediaStream | null>();
    for (const peer of voice.peers) {
      vNext.set(peer.actorId, peer.hasVideo ? getters.getPeerVideoStream(peer.actorId) : null);
      sNext.set(peer.actorId, peer.hasScreen ? getters.getPeerScreenStream(peer.actorId) : null);
    }
    setPeerVideoStreams(vNext);
    setPeerScreenStreams(sNext);
  }, [voice.peers, getters.getPeerVideoStream, getters.getPeerScreenStream]);

  return { localVideoStream, localScreenStream, peerVideoStreams, peerScreenStreams };
}
