// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useCallback } from 'react';
import type { AuthorView, WsServerMessage, WsClientMessage } from '@babelr/shared';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface VoicePeerState {
  actorId: string;
  actor: AuthorView;
  connected: boolean;
}

export interface UseVoiceState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  channelId: string | null;
  peers: VoicePeerState[];
  micMuted: boolean;
}

interface PeerEntry {
  actor: AuthorView;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  connected: boolean;
}

/**
 * WebRTC mesh voice channel hook.
 *
 * Flow:
 * 1. join(channelId) — opens a dedicated WebSocket, requests mic access,
 *    sends voice:join, waits for voice:room-state listing existing peers
 * 2. For each existing peer in the room state, create an RTCPeerConnection,
 *    attach local audio tracks, create an offer, send voice:offer via WS
 * 3. On incoming voice:offer (for new peers joining after us), create a
 *    peer connection, set remote, create answer, send voice:answer
 * 4. On incoming voice:answer, set remote description
 * 5. On incoming voice:ice, add candidate
 * 6. On voice:participant-left, close that connection
 * 7. leave() — tears down peers, releases mic, closes WS
 */
export function useVoice() {
  const [state, setState] = useState<UseVoiceState>({
    status: 'idle',
    error: null,
    channelId: null,
    peers: [],
    micMuted: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  // Actor metadata for participants we know about — populated from
  // voice:room-state (existing participants at join time) and
  // voice:participant-joined (peers joining after us). Consulted when a
  // voice:offer arrives so we can attach the correct display name to
  // the peer connection instead of falling back to "unknown".
  const knownActorsRef = useRef<Map<string, AuthorView>>(new Map());
  const channelIdRef = useRef<string | null>(null);

  const syncPeersToState = useCallback(() => {
    const arr: VoicePeerState[] = [];
    for (const [actorId, entry] of peersRef.current) {
      arr.push({ actorId, actor: entry.actor, connected: entry.connected });
    }
    setState((s) => ({ ...s, peers: arr }));
  }, []);

  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const createPeerConnection = useCallback(
    (actor: AuthorView, channelId: string): PeerEntry => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // Add local mic tracks
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          pc.addTrack(track, localStreamRef.current);
        }
      }

      // Remote audio sink
      const audio = new Audio();
      audio.autoplay = true;

      pc.ontrack = (ev) => {
        audio.srcObject = ev.streams[0];
        void audio.play().catch(() => {
          /* autoplay policy — user gesture required */
        });
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendWs({
            type: 'voice:ice',
            payload: {
              channelId,
              toActorId: actor.id,
              candidate: ev.candidate.toJSON(),
            },
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const entry = peersRef.current.get(actor.id);
        if (!entry) return;
        entry.connected = pc.connectionState === 'connected';
        syncPeersToState();
      };

      const entry: PeerEntry = { actor, pc, audio, connected: false };
      peersRef.current.set(actor.id, entry);
      syncPeersToState();
      return entry;
    },
    [sendWs, syncPeersToState],
  );

  const closePeer = useCallback(
    (actorId: string) => {
      const entry = peersRef.current.get(actorId);
      if (!entry) return;
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      entry.audio.pause();
      entry.audio.srcObject = null;
      peersRef.current.delete(actorId);
      syncPeersToState();
    },
    [syncPeersToState],
  );

  const handleMessage = useCallback(
    async (msg: WsServerMessage) => {
      const currentChannel = channelIdRef.current;
      if (!currentChannel) return;

      switch (msg.type) {
        case 'voice:room-state': {
          if (msg.payload.channelId !== currentChannel) return;
          // Record the existing participants so their metadata is available
          // if anything in this handler (or a later voice:offer) looks them up.
          for (const participant of msg.payload.participants) {
            knownActorsRef.current.set(participant.id, participant);
          }
          // Create an RTCPeerConnection and offer for each existing peer
          for (const participant of msg.payload.participants) {
            if (peersRef.current.has(participant.id)) continue;
            const entry = createPeerConnection(participant, currentChannel);
            try {
              const offer = await entry.pc.createOffer();
              await entry.pc.setLocalDescription(offer);
              sendWs({
                type: 'voice:offer',
                payload: {
                  channelId: currentChannel,
                  toActorId: participant.id,
                  sdp: offer.sdp ?? '',
                },
              });
            } catch (err) {
              console.error('offer failed', err);
            }
          }
          setState((s) => ({ ...s, status: 'connected' }));
          break;
        }

        case 'voice:participant-joined': {
          // We don't create the peer connection yet — the new joiner will
          // send us an offer. But we DO record their actor metadata so
          // that when their offer arrives, we can attach the right name
          // to the peer entry instead of the "unknown" fallback.
          if (msg.payload.channelId !== currentChannel) return;
          knownActorsRef.current.set(msg.payload.participant.id, msg.payload.participant);
          break;
        }

        case 'voice:participant-left': {
          if (msg.payload.channelId !== currentChannel) return;
          knownActorsRef.current.delete(msg.payload.actorId);
          closePeer(msg.payload.actorId);
          break;
        }

        case 'voice:offer': {
          if (msg.payload.channelId !== currentChannel) return;
          const fromId = msg.payload.fromActorId;
          // Ensure we have a peer entry (create if new). Prefer the actor
          // metadata we cached from voice:participant-joined or
          // voice:room-state; fall back to a minimal placeholder only if
          // the offer somehow arrives before either of those.
          let entry = peersRef.current.get(fromId);
          if (!entry) {
            const known = knownActorsRef.current.get(fromId);
            const actor: AuthorView = known ?? {
              id: fromId,
              preferredUsername: 'unknown',
              displayName: null,
              avatarUrl: null,
            };
            entry = createPeerConnection(actor, currentChannel);
          }
          try {
            await entry.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            sendWs({
              type: 'voice:answer',
              payload: {
                channelId: currentChannel,
                toActorId: fromId,
                sdp: answer.sdp ?? '',
              },
            });
          } catch (err) {
            console.error('answer failed', err);
          }
          break;
        }

        case 'voice:answer': {
          if (msg.payload.channelId !== currentChannel) return;
          const entry = peersRef.current.get(msg.payload.fromActorId);
          if (!entry) return;
          try {
            await entry.pc.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp });
          } catch (err) {
            console.error('setRemoteDescription answer failed', err);
          }
          break;
        }

        case 'voice:ice': {
          if (msg.payload.channelId !== currentChannel) return;
          const entry = peersRef.current.get(msg.payload.fromActorId);
          if (!entry) return;
          try {
            await entry.pc.addIceCandidate(msg.payload.candidate);
          } catch (err) {
            console.error('addIceCandidate failed', err);
          }
          break;
        }

        case 'voice:full': {
          if (msg.payload.channelId !== currentChannel) return;
          setState((s) => ({
            ...s,
            status: 'error',
            error: `Voice channel is full (max ${msg.payload.max}).`,
          }));
          break;
        }
      }
    },
    [createPeerConnection, closePeer, sendWs],
  );

  const join = useCallback(
    async (channelId: string) => {
      if (channelIdRef.current) {
        console.warn('Already in a voice channel');
        return;
      }
      setState({ status: 'connecting', error: null, channelId, peers: [], micMuted: false });
      channelIdRef.current = channelId;

      // Environment capability checks before attempting anything
      if (typeof RTCPeerConnection === 'undefined') {
        setState({
          status: 'error',
          error:
            'Voice channels require WebRTC, which is not available in this webview. On Linux, Arch and some other distributions ship webkit2gtk without WebRTC — open Babelr in Firefox or Chromium to join voice.',
          channelId: null,
          peers: [],
          micMuted: false,
        });
        channelIdRef.current = null;
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({
          status: 'error',
          error: 'Media capture is not available in this webview. Open Babelr in a browser to join voice.',
          channelId: null,
          peers: [],
          micMuted: false,
        });
        channelIdRef.current = null;
        return;
      }
      try {
        localStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch (err) {
        const message =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Microphone permission denied. Enable it in your system settings.'
            : err instanceof Error
              ? `Microphone error: ${err.message}`
              : 'Microphone access failed.';
        setState({
          status: 'error',
          error: message,
          channelId: null,
          peers: [],
          micMuted: false,
        });
        channelIdRef.current = null;
        return;
      }

      // Open dedicated WS for voice signaling
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        sendWs({ type: 'voice:join', payload: { channelId } });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsServerMessage;
          void handleMessage(msg);
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        // If the socket closes while we think we're connected, reset state
        if (channelIdRef.current === channelId) {
          // Tear down without sending voice:leave (socket is already closed)
          for (const actorId of Array.from(peersRef.current.keys())) {
            closePeer(actorId);
          }
          knownActorsRef.current.clear();
          if (localStreamRef.current) {
            for (const track of localStreamRef.current.getTracks()) track.stop();
            localStreamRef.current = null;
          }
          channelIdRef.current = null;
          wsRef.current = null;
          setState({ status: 'idle', error: null, channelId: null, peers: [], micMuted: false });
        }
      };
    },
    [sendWs, handleMessage, closePeer],
  );

  const leave = useCallback(() => {
    const current = channelIdRef.current;
    if (!current) return;
    sendWs({ type: 'voice:leave', payload: { channelId: current } });
    for (const actorId of Array.from(peersRef.current.keys())) {
      closePeer(actorId);
    }
    knownActorsRef.current.clear();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    channelIdRef.current = null;
    setState({ status: 'idle', error: null, channelId: null, peers: [], micMuted: false });
  }, [sendWs, closePeer]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !state.micMuted;
    for (const track of localStreamRef.current.getAudioTracks()) {
      track.enabled = !nextMuted;
    }
    setState((s) => ({ ...s, micMuted: nextMuted }));
  }, [state.micMuted]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      if (channelIdRef.current) {
        sendWs({ type: 'voice:leave', payload: { channelId: channelIdRef.current } });
      }
      for (const actorId of Array.from(peersRef.current.keys())) {
        closePeer(actorId);
      }
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) track.stop();
      }
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, join, leave, toggleMute };
}
