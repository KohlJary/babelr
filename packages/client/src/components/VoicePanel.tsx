// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { UseVoiceState } from '../hooks/useVoice';
import type { ActorProfile } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';
import { VoiceTile } from './VoiceTile';

interface VoicePanelProps {
  channelName: string;
  actor: ActorProfile;
  voice: UseVoiceState;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onTogglePushToTalk: () => void;
  onToggleVideo: () => void | Promise<void>;
  onToggleScreenShare: () => void | Promise<void>;
  onPeerVolume: (actorId: string, volume: number) => void;
  getLocalVideoStream: () => MediaStream | null;
  getPeerVideoStream: (actorId: string) => MediaStream | null;
  getLocalScreenStream: () => MediaStream | null;
  getPeerScreenStream: (actorId: string) => MediaStream | null;
}

export function VoicePanel({
  channelName,
  actor,
  voice,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onTogglePushToTalk,
  onToggleVideo,
  onToggleScreenShare,
  onPeerVolume,
  getLocalVideoStream,
  getPeerVideoStream,
  getLocalScreenStream,
  getPeerScreenStream,
}: VoicePanelProps) {
  const t = useT();

  // We poll the imperative stream getters into a state snapshot so React
  // re-renders VoiceTile when streams change. useVoice's state has
  // `hasVideo`/`hasScreen` booleans per peer and `videoEnabled`/
  // `screenShareEnabled` flags for self, which are the refresh triggers.
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [peerVideoStreams, setPeerVideoStreams] = useState<Map<string, MediaStream | null>>(
    new Map(),
  );
  const [peerScreenStreams, setPeerScreenStreams] = useState<Map<string, MediaStream | null>>(
    new Map(),
  );

  useEffect(() => {
    setLocalVideoStream(getLocalVideoStream());
  }, [voice.videoEnabled, getLocalVideoStream]);

  useEffect(() => {
    setLocalScreenStream(getLocalScreenStream());
  }, [voice.screenShareEnabled, getLocalScreenStream]);

  useEffect(() => {
    const vNext = new Map<string, MediaStream | null>();
    const sNext = new Map<string, MediaStream | null>();
    for (const peer of voice.peers) {
      vNext.set(peer.actorId, peer.hasVideo ? getPeerVideoStream(peer.actorId) : null);
      sNext.set(peer.actorId, peer.hasScreen ? getPeerScreenStream(peer.actorId) : null);
    }
    setPeerVideoStreams(vNext);
    setPeerScreenStreams(sNext);
  }, [voice.peers, getPeerVideoStream, getPeerScreenStream]);

  const selfActor = {
    id: actor.id,
    preferredUsername: actor.preferredUsername,
    displayName: actor.displayName,
    avatarUrl: actor.avatarUrl ?? null,
  };

  return (
    <div className="voice-panel">
      <div className="voice-panel-header">
        <div className="voice-panel-title">
          <span className="voice-panel-icon">🔊</span>
          <span className="voice-panel-name">{channelName}</span>
        </div>
        <span className={`voice-panel-status ${voice.status === 'connected' ? 'online' : ''}`}>
          {voice.status === 'connecting' && t('voice.connecting')}
          {voice.status === 'connected' && t('voice.connected')}
          {voice.status === 'error' && voice.error}
        </span>
      </div>

      {/* Webcam/avatar tiles — compact 4:3 grid. */}
      <div className="voice-tiles">
        <VoiceTile
          actor={selfActor}
          stream={localVideoStream}
          speaking={voice.localSpeaking}
          muted={voice.micMuted}
          isSelf
        />
        {voice.peers.map((peer) => (
          <VoiceTile
            key={peer.actorId}
            actor={peer.actor}
            stream={peerVideoStreams.get(peer.actorId) ?? null}
            speaking={peer.speaking}
            connected={peer.connected}
            volume={peer.volume}
            onVolumeChange={(v) => onPeerVolume(peer.actorId, v)}
          />
        ))}
        {voice.peers.length === 0 && voice.status === 'connected' && (
          <div className="voice-empty">{t('voice.noParticipants')}</div>
        )}
      </div>

      {/* Screen share tiles — separate stacked section, each tile is
          full-width at 16:9 so presentation content is readable. Only
          rendered when at least one participant is actually sharing. */}
      {(localScreenStream ||
        voice.peers.some((p) => p.hasScreen)) && (
        <div className="voice-screen-tiles">
          {localScreenStream && (
            <VoiceTile
              actor={selfActor}
              stream={localScreenStream}
              speaking={false}
              isSelf
              isScreen
            />
          )}
          {voice.peers.map((peer) =>
            peer.hasScreen ? (
              <VoiceTile
                key={`${peer.actorId}-screen`}
                actor={peer.actor}
                stream={peerScreenStreams.get(peer.actorId) ?? null}
                speaking={false}
                connected={peer.connected}
                isScreen
              />
            ) : null,
          )}
        </div>
      )}

      <div className="voice-controls">
        <button
          className={`voice-control-btn ${voice.micMuted ? 'active' : ''}`}
          onClick={onToggleMute}
          title={voice.micMuted ? t('voice.unmuteMic') : t('voice.muteMic')}
        >
          {voice.micMuted ? '🔇' : '🎤'}
        </button>
        <button
          className={`voice-control-btn ${voice.videoEnabled ? 'active-on' : ''}`}
          onClick={() => void onToggleVideo()}
          title={voice.videoEnabled ? t('voice.disableVideo') : t('voice.enableVideo')}
        >
          {voice.videoEnabled ? '📹' : '📷'}
        </button>
        <button
          className={`voice-control-btn ${voice.screenShareEnabled ? 'active-on' : ''}`}
          onClick={() => void onToggleScreenShare()}
          title={
            voice.screenShareEnabled
              ? t('voice.disableScreenShare')
              : t('voice.enableScreenShare')
          }
        >
          🖥️
        </button>
        <button
          className={`voice-control-btn ${voice.deafened ? 'active' : ''}`}
          onClick={onToggleDeafen}
          title={voice.deafened ? t('voice.undeafen') : t('voice.deafen')}
        >
          {voice.deafened ? '🙉' : '🔈'}
        </button>
        <button
          className={`voice-control-btn ${voice.pushToTalk ? 'active' : ''}`}
          onClick={onTogglePushToTalk}
          title={voice.pushToTalk ? t('voice.pttOff') : t('voice.pttOnTitle')}
        >
          PTT
        </button>
        <button className="voice-control-btn leave" onClick={onLeave}>
          {t('voice.leave')}
        </button>
      </div>
      {voice.pushToTalk && <div className="voice-ptt-hint">{t('voice.pttHint')}</div>}
    </div>
  );
}
