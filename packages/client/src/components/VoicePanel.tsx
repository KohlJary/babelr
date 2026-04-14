// SPDX-License-Identifier: Hippocratic-3.0
import type { UseVoiceState } from '../hooks/useVoice';
import type { ActorProfile } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';
import { VoiceTile } from './VoiceTile';
import { VoiceControls } from './VoiceControls';
import { useVoiceStreams } from '../hooks/useVoiceStreams';

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

/**
 * Floating-widget call surface, shown when the user is in a call but
 * NOT viewing the corresponding voice channel. When the channel is
 * selected the full-size CallView replaces this widget.
 */
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
  const { localVideoStream, localScreenStream, peerVideoStreams, peerScreenStreams } =
    useVoiceStreams(voice, {
      getLocalVideoStream,
      getLocalScreenStream,
      getPeerVideoStream,
      getPeerScreenStream,
    });

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

      {(localScreenStream || voice.peers.some((p) => p.hasScreen)) && (
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

      <VoiceControls
        voice={voice}
        onLeave={onLeave}
        onToggleMute={onToggleMute}
        onToggleDeafen={onToggleDeafen}
        onTogglePushToTalk={onTogglePushToTalk}
        onToggleVideo={onToggleVideo}
        onToggleScreenShare={onToggleScreenShare}
      />
      {voice.pushToTalk && <div className="voice-ptt-hint">{t('voice.pttHint')}</div>}
    </div>
  );
}
