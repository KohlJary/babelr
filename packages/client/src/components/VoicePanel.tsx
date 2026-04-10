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
  onPeerVolume: (actorId: string, volume: number) => void;
  getLocalVideoStream: () => MediaStream | null;
  getPeerVideoStream: (actorId: string) => MediaStream | null;
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
  onPeerVolume,
  getLocalVideoStream,
  getPeerVideoStream,
}: VoicePanelProps) {
  const t = useT();

  // We poll the imperative stream getters into a state snapshot so React
  // re-renders VoiceTile when streams change. useVoice's state has a
  // `hasVideo` boolean per peer and a `videoEnabled` flag for self, which
  // is what we watch for the refresh trigger.
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [peerVideoStreams, setPeerVideoStreams] = useState<Map<string, MediaStream | null>>(
    new Map(),
  );

  useEffect(() => {
    setLocalVideoStream(getLocalVideoStream());
  }, [voice.videoEnabled, getLocalVideoStream]);

  useEffect(() => {
    const next = new Map<string, MediaStream | null>();
    for (const peer of voice.peers) {
      next.set(peer.actorId, peer.hasVideo ? getPeerVideoStream(peer.actorId) : null);
    }
    setPeerVideoStreams(next);
  }, [voice.peers, getPeerVideoStream]);

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
