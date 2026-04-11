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
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  // Webcam: first video transceiver added to the PC
  videoSender: RTCRtpSender | null;
  videoTransceiver: RTCRtpTransceiver | null;
  videoStream: MediaStream | null;
  // Screen share: second video transceiver added to the PC
  screenSender: RTCRtpSender | null;
  screenTransceiver: RTCRtpTransceiver | null;
  screenStream: MediaStream | null;
  connected: boolean;
  analyser: AnalyserNode | null;
  analyserBuf: Uint8Array<ArrayBuffer> | null;
  speaking: boolean;
  volume: number;
  // Glare guard: true between createOffer() and receiving the matching
  // voice:answer (or rolling back on a remote offer arriving during the
  // window). Prevents two simultaneous renegotiations from corrupting
  // the peer connection's signaling state.
  makingOffer: boolean;
}

/** Signal-strength threshold (0–255) above which we consider a track "speaking". */
const SPEAKING_THRESHOLD = 18;
/** Key that gates voice transmission when push-to-talk mode is enabled. */
const PTT_KEY = '`';

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
export function useVoice(selfActorId: string) {
  const [state, setState] = useState<UseVoiceState>(IDLE_STATE);

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Separate MediaStream for the user's webcam — acquired lazily the first
  // time they turn video on, released when they turn it off. Kept distinct
  // from the mic stream so stopping one doesn't affect the other.
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  // Separate MediaStream for screen share (getDisplayMedia). Completely
  // independent of the webcam — a user can have both active at once.
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  // Shared AudioContext for all analyser nodes (local mic + each peer).
  // Created lazily on join() so we don't spin up audio machinery for
  // users who never enter a voice channel.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<{
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    buf: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const localMicLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakingRafRef = useRef<number | null>(null);
  const lastReconcileRef = useRef(0);
  // Push-to-talk runtime state. When `pushToTalk` is true in state, the
  // mic is muted by default and only un-muted while PTT_KEY is held down.
  // These refs let the keydown/keyup listeners read the latest values
  // without re-binding on every state change.
  const pttEnabledRef = useRef(false);
  const pttKeyHeldRef = useRef(false);
  const micMutedRef = useRef(false);
  const deafenedRef = useRef(false);
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
      arr.push({
        actorId,
        actor: entry.actor,
        connected: entry.connected,
        speaking: entry.speaking,
        volume: entry.volume,
        hasVideo: entry.videoStream !== null,
        hasScreen: entry.screenStream !== null,
      });
    }
    setState((s) => ({ ...s, peers: arr }));
  }, []);

  /** Compute whether the local mic track should currently be enabled. */
  const applyMicEnabled = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const allowed =
      !micMutedRef.current &&
      !deafenedRef.current &&
      (!pttEnabledRef.current || pttKeyHeldRef.current);
    for (const track of stream.getAudioTracks()) {
      track.enabled = allowed;
    }
  }, []);

  /** Apply the deafened state to every remote audio element. */
  const applyDeafened = useCallback(() => {
    for (const entry of peersRef.current.values()) {
      entry.audio.muted = deafenedRef.current;
    }
  }, []);


  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  /**
   * Trigger a renegotiation on a single peer by creating a fresh offer
   * and sending it over the signaling channel. Needed after replaceTrack
   * on a video/screen transceiver because — in practice, despite what the
   * spec says — adding a track to a transceiver that was negotiated with
   * no track leaves the effective SDP direction in a state where the new
   * track doesn't actually flow until a new offer/answer exchange.
   *
   * Glare handling: we mark makingOffer = true before creating the offer
   * and clear it when the matching answer arrives. If the signaling state
   * transitions out of 'stable' mid-call (e.g. because a remote offer
   * arrived during our createOffer await), we skip sending to avoid
   * corrupting the PC's state.
   */
  const renegotiatePeer = useCallback(
    async (entry: PeerEntry, channelId: string) => {
      try {
        entry.makingOffer = true;
        const offer = await entry.pc.createOffer();
        if (entry.pc.signalingState !== 'stable') {
          console.warn(
            'voice: skipping renegotiation, signalingState =',
            entry.pc.signalingState,
          );
          return;
        }
        await entry.pc.setLocalDescription(offer);
        sendWs({
          type: 'voice:offer',
          payload: {
            channelId,
            toActorId: entry.actor.id,
            sdp: offer.sdp ?? '',
          },
        });
      } catch (err) {
        console.warn('voice: renegotiation failed for', entry.actor.id, err);
      } finally {
        entry.makingOffer = false;
      }
    },
    [sendWs],
  );

  /** Renegotiate every connected peer. Called after local toggles. */
  const renegotiateAllPeers = useCallback(async () => {
    const channel = channelIdRef.current;
    if (!channel) return;
    const jobs: Promise<void>[] = [];
    for (const entry of peersRef.current.values()) {
      jobs.push(renegotiatePeer(entry, channel));
    }
    await Promise.all(jobs);
  }, [renegotiatePeer]);

  /**
   * Reconcile peer slot state from the current RTCPeerConnection receivers.
   * Called after renegotiation completes AND from the periodic rAF tick.
   *
   * Uses pc.getTransceivers() ORDER as the source of truth for which
   * transceiver is the webcam slot vs the screen slot — not stored
   * transceiver references, which can become ambiguous across
   * renegotiations. Index 0 among video transceivers = webcam,
   * index 1 = screen.
   *
   * `canClear`: when true (the post-renegotiation path), an empty-looking
   * track causes the slot to be cleared. When false (the periodic rAF
   * path), we ONLY populate empty slots from live tracks. The periodic
   * path can't clear because polling `track.muted` / `track.readyState`
   * from a rAF loop produces false negatives during normal operation —
   * a transient "muted" reading would oscillate the slot state. The
   * onmute/onended handlers plus the post-renegotiation reconcile are
   * responsible for teardown.
   */
  const reconcilePeerSlots = useCallback(
    (entry: PeerEntry, canClear = true) => {
      const videoTxs = entry.pc
        .getTransceivers()
        .filter((t) => t.receiver.track?.kind === 'video');
      for (let i = 0; i < videoTxs.length && i < 2; i++) {
        const tx = videoTxs[i];
        const slot: 'video' | 'screen' = i === 0 ? 'video' : 'screen';
        const track = tx.receiver.track;
        if (!track) continue;
        const live = track.readyState === 'live' && !track.muted;
        const currentSlot = slot === 'video' ? entry.videoStream : entry.screenStream;
        if (live && !currentSlot) {
          const stream = new MediaStream([track]);
          if (slot === 'video') entry.videoStream = stream;
          else entry.screenStream = stream;
          console.log('voice: reconcile populate', {
            from: entry.actor.id,
            slot,
            direction: tx.currentDirection,
          });
          syncPeersToState();
        } else if (canClear && !live && currentSlot) {
          if (slot === 'video') entry.videoStream = null;
          else entry.screenStream = null;
          console.log('voice: reconcile clear', {
            from: entry.actor.id,
            slot,
            direction: tx.currentDirection,
            muted: track.muted,
            readyState: track.readyState,
          });
          syncPeersToState();
        }
      }
    },
    [syncPeersToState],
  );

  const createPeerConnection = useCallback(
    (actor: AuthorView, channelId: string): PeerEntry => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // Add local mic tracks
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          pc.addTrack(track, localStreamRef.current);
        }
      }

      // Pre-add TWO sendrecv video transceivers so both webcam and screen
      // share can be toggled later via replaceTrack WITHOUT SDP
      // renegotiation. Order is significant — the receiver uses the
      // transceiver's position in the SDP (via getTransceivers() order) to
      // route incoming tracks to the correct slot. Webcam is always added
      // FIRST, screen share SECOND.
      let videoSender: RTCRtpSender | null = null;
      let videoTransceiver: RTCRtpTransceiver | null = null;
      let screenSender: RTCRtpSender | null = null;
      let screenTransceiver: RTCRtpTransceiver | null = null;
      try {
        videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
        videoSender = videoTransceiver.sender;
        if (localVideoStreamRef.current) {
          const videoTrack = localVideoStreamRef.current.getVideoTracks()[0];
          if (videoTrack) {
            void videoSender.replaceTrack(videoTrack);
          }
        }
      } catch (err) {
        console.warn('voice: failed to add video transceiver', err);
      }
      try {
        screenTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
        screenSender = screenTransceiver.sender;
        if (localScreenStreamRef.current) {
          const screenTrack = localScreenStreamRef.current.getVideoTracks()[0];
          if (screenTrack) {
            void screenSender.replaceTrack(screenTrack);
          }
        }
      } catch (err) {
        console.warn('voice: failed to add screen share transceiver', err);
      }

      // Remote audio sink. The element MUST be attached to the DOM for
      // reliable playback — detached HTMLAudioElement instances will set
      // srcObject without error but produce no audible output in Safari
      // and some Chrome versions. We mount invisibly and remove on
      // closePeer to keep the DOM clean.
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      audio.style.display = 'none';
      audio.dataset.voicePeerId = actor.id;
      document.body.appendChild(audio);

      pc.ontrack = (ev) => {
        // Video track handling: determine which slot (webcam vs screen)
        // using a combination of identity check and index fallback, both
        // wrapped in a try/catch so a routing failure can't wedge the
        // whole ontrack handler.
        //
        // Ordering rule: we always addTransceiver('video') twice — webcam
        // first, screen second — so the two video transceivers on the PC
        // correspond to slots 'video' and 'screen' in that order.
        if (ev.track.kind === 'video') {
          const pe = peersRef.current.get(actor.id);
          if (!pe) return;

          let slot: 'video' | 'screen' = 'video';
          try {
            // Primary: identity match against stored transceiver refs
            if (ev.transceiver === pe.videoTransceiver) {
              slot = 'video';
            } else if (ev.transceiver === pe.screenTransceiver) {
              slot = 'screen';
            } else {
              // Fallback: find the transceiver's position in the PC's
              // video-track transceivers. Use optional chaining on
              // receiver.track in case any transceiver lacks one.
              const videoTxs = pc
                .getTransceivers()
                .filter((t) => t.receiver.track?.kind === 'video');
              const index = videoTxs.indexOf(ev.transceiver);
              if (index === 1) slot = 'screen';
              else if (index === 0) slot = 'video';
              // If index is -1 (not found), last-ditch: use whichever
              // slot is currently empty (webcam first). Keeps legacy
              // behavior for the case where nothing else matches.
              else if (pe.videoStream === null) slot = 'video';
              else slot = 'screen';
            }
          } catch (err) {
            console.warn('voice: ontrack routing failed, defaulting to video', err);
            slot = 'video';
          }

          // A track arriving from a transceiver whose remote side has no
          // real track attached (e.g. because we pre-allocate both video
          // transceivers but the remote user only enabled one) comes in
          // muted. We must NOT populate the slot in that case or the UI
          // will render an empty tile forever. Wait for the onunmute
          // event, which fires when the remote actually attaches a track.
          const populateSlot = (reason: string) => {
            const p = peersRef.current.get(actor.id);
            if (!p) return;
            const stream = new MediaStream([ev.track]);
            if (slot === 'video') p.videoStream = stream;
            else p.screenStream = stream;
            console.log('voice: populate', {
              from: actor.id,
              slot,
              reason,
            });
            syncPeersToState();
          };
          const clearSlot = (reason: string) => {
            const p = peersRef.current.get(actor.id);
            if (!p) return;
            if (slot === 'video') p.videoStream = null;
            else p.screenStream = null;
            console.log('voice: clear', { from: actor.id, slot, reason });
            syncPeersToState();
          };

          if (!ev.track.muted) {
            populateSlot('initial ontrack, not muted');
          }
          ev.track.onended = () => {
            console.log('voice: track onended', { from: actor.id, slot });
            clearSlot('onended');
          };
          ev.track.onmute = () => {
            console.log('voice: track onmute', { from: actor.id, slot });
            clearSlot('onmute');
          };
          ev.track.onunmute = () => {
            console.log('voice: track onunmute', { from: actor.id, slot });
            populateSlot('onunmute');
          };

          console.log('voice: ontrack video', {
            from: actor.id,
            slot,
            muted: ev.track.muted,
            populated: !ev.track.muted,
          });
          return;
        }
        // Prefer the provided stream, but fall back to wrapping the track
        // if the negotiated SDP didn't include a stream id on the remote side.
        const stream =
          ev.streams && ev.streams.length > 0 ? ev.streams[0] : new MediaStream([ev.track]);
        audio.srcObject = stream;
        audio.volume = 1.0;
        audio.muted = deafenedRef.current;
        // Attach an AnalyserNode to this remote stream for the speaking
        // indicator. Uses the shared AudioContext created in join().
        const ctx = audioCtxRef.current;
        if (ctx) {
          try {
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            const e = peersRef.current.get(actor.id);
            if (e) {
              e.analyser = analyser;
              e.analyserBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
            }
          } catch (err) {
            console.warn('voice: failed to attach peer analyser', err);
          }
        }
        console.log('voice: ontrack', {
          from: actor.id,
          kind: ev.track.kind,
          enabled: ev.track.enabled,
          muted: ev.track.muted,
          readyState: ev.track.readyState,
          label: ev.track.label,
          streamTracks: stream.getTracks().map((t) => ({
            kind: t.kind,
            enabled: t.enabled,
            muted: t.muted,
          })),
        });
        void audio.play().catch((err) => {
          console.warn('voice: audio.play() rejected', err);
        });
        // Sanity-check the element state a moment later — if volume is
        // right, paused is false, and currentTime is advancing but we
        // still hear nothing, the issue is routing/OS/AEC rather than
        // the element itself.
        setTimeout(() => {
          console.log('voice: audio element state', {
            from: actor.id,
            volume: audio.volume,
            muted: audio.muted,
            paused: audio.paused,
            currentTime: audio.currentTime,
            readyState: audio.readyState,
            ended: audio.ended,
          });
        }, 1500);
        // And log WebRTC inbound stats — bytesReceived > 0 means media is
        // flowing at the protocol level.
        setTimeout(async () => {
          try {
            const stats = await pc.getStats();
            stats.forEach((report) => {
              if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                console.log('voice: inbound-rtp audio', {
                  from: actor.id,
                  bytesReceived: report.bytesReceived,
                  packetsReceived: report.packetsReceived,
                  audioLevel: report.audioLevel,
                });
              }
              if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                console.log('voice: outbound-rtp audio', {
                  to: actor.id,
                  bytesSent: report.bytesSent,
                  packetsSent: report.packetsSent,
                });
              }
              if (report.type === 'media-source' && report.kind === 'audio') {
                console.log('voice: media-source audio (our mic)', {
                  audioLevel: report.audioLevel,
                  totalAudioEnergy: report.totalAudioEnergy,
                });
              }
            });
          } catch (err) {
            console.warn('voice: getStats failed', err);
          }
        }, 2500);
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

      const entry: PeerEntry = {
        actor,
        pc,
        audio,
        videoSender,
        videoTransceiver,
        videoStream: null,
        screenSender,
        screenTransceiver,
        screenStream: null,
        connected: false,
        analyser: null,
        analyserBuf: null,
        speaking: false,
        volume: 1.0,
        makingOffer: false,
      };
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
      if (entry.audio.parentNode) {
        entry.audio.parentNode.removeChild(entry.audio);
      }
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
          // Perfect-negotiation-lite glare handling. If we're also making
          // an offer right now, both sides need to resolve the collision.
          // The peer with the lower actor id is "polite" and rolls back
          // their local offer to accept the remote; the impolite peer
          // ignores the remote offer and expects the polite one to retry.
          const isPolite = selfActorId < fromId;
          const offerCollision =
            entry.makingOffer || entry.pc.signalingState !== 'stable';
          if (offerCollision && !isPolite) {
            console.log('voice: offer collision, impolite — ignoring remote offer');
            break;
          }
          try {
            if (offerCollision && isPolite) {
              console.log('voice: offer collision, polite — rolling back');
              // Roll our local offer back by setting an answer-style
              // "rollback" description, then accept the remote offer.
              await entry.pc.setLocalDescription({ type: 'rollback' });
            }
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
            // Reconcile slot state after the answer is set up — covers
            // cases where onunmute doesn't fire reliably.
            reconcilePeerSlots(entry);
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
            // Reconcile slot state on the initiating side too — covers
            // the case where the remote end attached a new track and the
            // answer is completing our renegotiation. onunmute on the
            // receivers here is unreliable for the same reason.
            reconcilePeerSlots(entry);
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
      setState({ ...IDLE_STATE, status: 'connecting', channelId });
      channelIdRef.current = channelId;

      // Environment capability checks before attempting anything
      if (typeof RTCPeerConnection === 'undefined') {
        setState({
          ...IDLE_STATE,
          status: 'error',
          error:
            'Voice channels require WebRTC, which is not available in this webview. On Linux, Arch and some other distributions ship webkit2gtk without WebRTC — open Babelr in Firefox or Chromium to join voice.',
        });
        channelIdRef.current = null;
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({
          ...IDLE_STATE,
          status: 'error',
          error: 'Media capture is not available in this webview. Open Babelr in a browser to join voice.',
        });
        channelIdRef.current = null;
        return;
      }
      try {
        localStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        console.log(
          'voice: local mic acquired',
          localStreamRef.current.getAudioTracks().map((t) => ({
            label: t.label,
            enabled: t.enabled,
            readyState: t.readyState,
          })),
        );

        // Shared AudioContext + local analyser for both the diagnostic
        // level log and the speaking indicator loop.
        try {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          audioCtxRef.current = new AudioCtx();
          const source = audioCtxRef.current.createMediaStreamSource(localStreamRef.current);
          const analyser = audioCtxRef.current.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
          localAnalyserRef.current = { analyser, source, buf };
          // Diagnostic log every 2s for "silent mic" troubleshooting.
          // Still useful even with the speaking indicator in place.
          localMicLogIntervalRef.current = setInterval(() => {
            analyser.getByteFrequencyData(buf);
            let sum = 0;
            let peak = 0;
            for (const v of buf) {
              sum += v;
              if (v > peak) peak = v;
            }
            const avg = sum / buf.length;
            console.log(`voice: local mic level avg=${avg.toFixed(1)} peak=${peak}`);
          }, 2000);
        } catch (err) {
          console.warn('voice: failed to start audio analyser', err);
        }
      } catch (err) {
        const message =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Microphone permission denied. Enable it in your system settings.'
            : err instanceof Error
              ? `Microphone error: ${err.message}`
              : 'Microphone access failed.';
        setState({
          ...IDLE_STATE,
          status: 'error',
          error: message,
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
          teardownAudioRuntime();
          if (localStreamRef.current) {
            for (const track of localStreamRef.current.getTracks()) track.stop();
            localStreamRef.current = null;
          }
          channelIdRef.current = null;
          wsRef.current = null;
          setState(IDLE_STATE);
        }
      };
    },
    [sendWs, handleMessage, closePeer],
  );

  /**
   * Tear down the AudioContext, analyser nodes, mic level interval, and
   * speaking rAF loop. Safe to call multiple times.
   */
  const teardownAudioRuntime = useCallback(() => {
    if (localMicLogIntervalRef.current) {
      clearInterval(localMicLogIntervalRef.current);
      localMicLogIntervalRef.current = null;
    }
    if (speakingRafRef.current) {
      cancelAnimationFrame(speakingRafRef.current);
      speakingRafRef.current = null;
    }
    if (localAnalyserRef.current) {
      try {
        localAnalyserRef.current.source.disconnect();
      } catch {
        /* ignore */
      }
      localAnalyserRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
    }
  }, []);

  const leave = useCallback(() => {
    const current = channelIdRef.current;
    if (!current) return;
    sendWs({ type: 'voice:leave', payload: { channelId: current } });
    for (const actorId of Array.from(peersRef.current.keys())) {
      closePeer(actorId);
    }
    knownActorsRef.current.clear();
    teardownAudioRuntime();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    if (localVideoStreamRef.current) {
      for (const track of localVideoStreamRef.current.getTracks()) track.stop();
      localVideoStreamRef.current = null;
    }
    if (localScreenStreamRef.current) {
      for (const track of localScreenStreamRef.current.getTracks()) track.stop();
      localScreenStreamRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    channelIdRef.current = null;
    pttEnabledRef.current = false;
    pttKeyHeldRef.current = false;
    micMutedRef.current = false;
    deafenedRef.current = false;
    setState(IDLE_STATE);
  }, [sendWs, closePeer, teardownAudioRuntime]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !micMutedRef.current;
    micMutedRef.current = nextMuted;
    applyMicEnabled();
    setState((s) => ({ ...s, micMuted: nextMuted }));
  }, [applyMicEnabled]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    applyDeafened();
    applyMicEnabled();
    setState((s) => ({ ...s, deafened: next }));
  }, [applyDeafened, applyMicEnabled]);

  const togglePushToTalk = useCallback(() => {
    const next = !pttEnabledRef.current;
    pttEnabledRef.current = next;
    pttKeyHeldRef.current = false;
    applyMicEnabled();
    setState((s) => ({ ...s, pushToTalk: next }));
  }, [applyMicEnabled]);

  const setPeerVolume = useCallback(
    (actorId: string, volume: number) => {
      const clamped = Math.max(0, Math.min(1, volume));
      const entry = peersRef.current.get(actorId);
      if (!entry) return;
      entry.audio.volume = clamped;
      entry.volume = clamped;
      syncPeersToState();
    },
    [syncPeersToState],
  );

  /**
   * Toggle the local webcam. Acquires a separate video MediaStream via
   * getUserMedia on first enable, swaps the track into every peer's
   * pre-allocated video sender, and releases the stream on disable. No
   * SDP renegotiation happens — the transceivers were set up for video
   * at peer-connection creation time.
   */
  const toggleVideo = useCallback(async () => {
    // Currently off → turn on
    if (!localVideoStreamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        localVideoStreamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No video track in acquired stream');
        // Attach to every peer's video sender, then renegotiate so the
        // effective SDP direction becomes sendrecv-active.
        for (const entry of peersRef.current.values()) {
          if (entry.videoSender) {
            try {
              await entry.videoSender.replaceTrack(track);
            } catch (err) {
              console.warn('voice: failed to replaceTrack(video) on peer', entry.actor.id, err);
            }
          }
        }
        await renegotiateAllPeers();
        // If the track ends unexpectedly (user revoked permission, camera
        // unplugged), mirror that into state and release the stream.
        track.onended = () => {
          if (localVideoStreamRef.current) {
            for (const t of localVideoStreamRef.current.getTracks()) t.stop();
            localVideoStreamRef.current = null;
          }
          for (const entry of peersRef.current.values()) {
            if (entry.videoSender) {
              void entry.videoSender.replaceTrack(null).catch(() => {});
            }
          }
          setState((s) => ({ ...s, videoEnabled: false }));
        };
        setState((s) => ({ ...s, videoEnabled: true }));
      } catch (err) {
        console.warn('voice: getUserMedia video failed', err);
        setState((s) => ({
          ...s,
          error:
            err instanceof Error && err.name === 'NotAllowedError'
              ? 'Camera permission denied.'
              : err instanceof Error
                ? `Camera error: ${err.message}`
                : 'Failed to start camera.',
        }));
      }
      return;
    }
    // Currently on → turn off. Crucially, we do NOT renegotiate on
    // disable. replaceTrack(null) stops transmission; the receiver's
    // track goes muted and onmute clears their slot. Triggering a
    // renegotiation here was causing the receiver's transceiver to
    // transition into a state that the subsequent re-enable could not
    // recover from — the track would stay muted forever on re-enable,
    // which is exactly the "second toggle" bug.
    for (const entry of peersRef.current.values()) {
      if (entry.videoSender) {
        try {
          await entry.videoSender.replaceTrack(null);
        } catch (err) {
          console.warn('voice: failed to clear video track on peer', entry.actor.id, err);
        }
      }
    }
    for (const track of localVideoStreamRef.current.getTracks()) track.stop();
    localVideoStreamRef.current = null;
    setState((s) => ({ ...s, videoEnabled: false }));
  }, []);

  /** Imperative accessor so VoicePanel can attach the local stream to a <video>. */
  const getLocalVideoStream = useCallback((): MediaStream | null => {
    return localVideoStreamRef.current;
  }, []);

  /** Imperative accessor for a peer's current video stream. */
  const getPeerVideoStream = useCallback((actorId: string): MediaStream | null => {
    return peersRef.current.get(actorId)?.videoStream ?? null;
  }, []);

  /**
   * Toggle screen sharing. Completely independent of webcam — the user
   * can have both active simultaneously. Uses the second video transceiver
   * pre-allocated in createPeerConnection, so no SDP renegotiation.
   */
  const toggleScreenShare = useCallback(async () => {
    // Currently off → start sharing
    if (!localScreenStreamRef.current) {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setState((s) => ({
          ...s,
          error: 'Screen sharing is not available in this browser.',
        }));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        localScreenStreamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No video track in display media stream');

        // Attach the screen track to every peer's screen sender, then
        // renegotiate for the same reason as webcam.
        for (const entry of peersRef.current.values()) {
          if (entry.screenSender) {
            try {
              await entry.screenSender.replaceTrack(track);
            } catch (err) {
              console.warn(
                'voice: failed to replaceTrack(screen) on peer',
                entry.actor.id,
                err,
              );
            }
          }
        }
        await renegotiateAllPeers();

        // The browser's native "Stop sharing" bar fires track.onended
        // when the user clicks it. Mirror that into state.
        track.onended = () => {
          if (localScreenStreamRef.current) {
            for (const t of localScreenStreamRef.current.getTracks()) t.stop();
            localScreenStreamRef.current = null;
          }
          for (const entry of peersRef.current.values()) {
            if (entry.screenSender) {
              void entry.screenSender.replaceTrack(null).catch(() => {});
            }
          }
          setState((s) => ({ ...s, screenShareEnabled: false }));
        };
        setState((s) => ({ ...s, screenShareEnabled: true }));
      } catch (err) {
        // User cancelling the screen picker throws NotAllowedError; don't
        // treat that as an error the user needs to see.
        if (err instanceof Error && err.name !== 'NotAllowedError') {
          console.warn('voice: getDisplayMedia failed', err);
          setState((s) => ({
            ...s,
            error: `Screen share error: ${err.message}`,
          }));
        }
      }
      return;
    }
    // Currently on → stop sharing. Same reasoning as toggleVideo off:
    // don't renegotiate here. replaceTrack(null) plus the natural
    // onmute transition handles the teardown; renegotiating leaves
    // the receiver's transceiver in a state that re-enable can't
    // recover from.
    for (const entry of peersRef.current.values()) {
      if (entry.screenSender) {
        try {
          await entry.screenSender.replaceTrack(null);
        } catch (err) {
          console.warn('voice: failed to clear screen track on peer', entry.actor.id, err);
        }
      }
    }
    for (const track of localScreenStreamRef.current.getTracks()) track.stop();
    localScreenStreamRef.current = null;
    setState((s) => ({ ...s, screenShareEnabled: false }));
  }, []);

  const getLocalScreenStream = useCallback((): MediaStream | null => {
    return localScreenStreamRef.current;
  }, []);

  const getPeerScreenStream = useCallback((actorId: string): MediaStream | null => {
    return peersRef.current.get(actorId)?.screenStream ?? null;
  }, []);

  // Speaking-indicator rAF loop. Runs whenever we're in a voice channel.
  // Reads the frequency data from the local and peer analysers and flips
  // `speaking` state when a participant crosses the threshold. State is
  // only setState'd when at least one speaking boolean actually changed,
  // so the render churn is limited to speech onsets/offsets.
  useEffect(() => {
    if (state.status !== 'connected' && state.status !== 'connecting') return;

    const tick = () => {
      let changed = false;

      // Local (me)
      let nextLocalSpeaking = false;
      const la = localAnalyserRef.current;
      if (la) {
        la.analyser.getByteFrequencyData(la.buf);
        let peak = 0;
        for (const v of la.buf) if (v > peak) peak = v;
        // Only count as speaking if the mic is actually hot (not muted/deafened/PTT-off)
        const micHot =
          !micMutedRef.current &&
          !deafenedRef.current &&
          (!pttEnabledRef.current || pttKeyHeldRef.current);
        nextLocalSpeaking = micHot && peak > SPEAKING_THRESHOLD;
      }

      // Each peer
      for (const entry of peersRef.current.values()) {
        if (!entry.analyser || !entry.analyserBuf) continue;
        entry.analyser.getByteFrequencyData(entry.analyserBuf);
        let peak = 0;
        for (const v of entry.analyserBuf) if (v > peak) peak = v;
        const nextSpeaking = peak > SPEAKING_THRESHOLD;
        if (nextSpeaking !== entry.speaking) {
          entry.speaking = nextSpeaking;
          changed = true;
        }
      }

      setState((s) => {
        const localChanged = nextLocalSpeaking !== s.localSpeaking;
        if (!changed && !localChanged) return s;
        return {
          ...s,
          localSpeaking: nextLocalSpeaking,
          peers: Array.from(peersRef.current.values()).map((e) => ({
            actorId: e.actor.id,
            actor: e.actor,
            connected: e.connected,
            speaking: e.speaking,
            volume: e.volume,
            hasVideo: e.videoStream !== null,
            hasScreen: e.screenStream !== null,
          })),
        };
      });

      // Throttled populate-only reconcile. Catches muted→unmuted
      // transitions that onunmute misses (notably the "second toggle"
      // case). IMPORTANT: this path passes canClear=false because
      // polling track.muted from rAF produces false-negative clears —
      // transient readings would oscillate the slot state. Teardown
      // is handled exclusively by onmute/onended and the explicit
      // post-renegotiation reconcile, both of which see stable
      // transitions rather than polled snapshots.
      const now = performance.now();
      if (now - lastReconcileRef.current > 500) {
        lastReconcileRef.current = now;
        // Verbose scan log: dump the state of every peer's video/screen
        // transceivers so we can see exactly what's happening during a
        // re-enable cycle.
        for (const entry of peersRef.current.values()) {
          const txs = entry.pc
            .getTransceivers()
            .filter((t) => t.receiver.track?.kind === 'video');
          console.log('voice: reconcile scan', {
            peer: entry.actor.id,
            slotVideo: entry.videoStream !== null,
            slotScreen: entry.screenStream !== null,
            txs: txs.map((t, i) => ({
              i,
              currentDirection: t.currentDirection,
              trackReadyState: t.receiver.track?.readyState,
              trackMuted: t.receiver.track?.muted,
              trackId: t.receiver.track?.id,
            })),
          });
          reconcilePeerSlots(entry, false);
        }
      }

      speakingRafRef.current = requestAnimationFrame(tick);
    };

    speakingRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (speakingRafRef.current) {
        cancelAnimationFrame(speakingRafRef.current);
        speakingRafRef.current = null;
      }
    };
  }, [state.status]);

  // Push-to-talk global key listener. Active whenever PTT mode is on.
  // Ignores keydown/keyup while the user is typing into an input or
  // contenteditable element so the key doesn't eat intended input.
  useEffect(() => {
    if (!state.pushToTalk) return;

    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (isEditable(e.target)) return;
      if (pttKeyHeldRef.current) return;
      pttKeyHeldRef.current = true;
      applyMicEnabled();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      if (!pttKeyHeldRef.current) return;
      pttKeyHeldRef.current = false;
      applyMicEnabled();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [state.pushToTalk, applyMicEnabled]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      if (channelIdRef.current) {
        sendWs({ type: 'voice:leave', payload: { channelId: channelIdRef.current } });
      }
      for (const actorId of Array.from(peersRef.current.keys())) {
        closePeer(actorId);
      }
      teardownAudioRuntime();
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) track.stop();
      }
      if (localVideoStreamRef.current) {
        for (const track of localVideoStreamRef.current.getTracks()) track.stop();
      }
      if (localScreenStreamRef.current) {
        for (const track of localScreenStreamRef.current.getTracks()) track.stop();
      }
      wsRef.current?.close();
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
