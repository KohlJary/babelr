// SPDX-License-Identifier: Hippocratic-3.0
import type { UseVoiceState } from '../hooks/useVoice';
import type { ActorProfile } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface VoicePanelProps {
  channelName: string;
  actor: ActorProfile;
  voice: UseVoiceState;
  onLeave: () => void;
  onToggleMute: () => void;
}

export function VoicePanel({
  channelName,
  actor,
  voice,
  onLeave,
  onToggleMute,
}: VoicePanelProps) {
  const t = useT();

  return (
    <div className="voice-panel">
      <div className="voice-panel-header">
        <div className="voice-panel-title">
          <span className="voice-panel-icon">🔊</span>
          <span className="voice-panel-name">{channelName}</span>
        </div>
        <span
          className={`voice-panel-status ${voice.status === 'connected' ? 'online' : ''}`}
        >
          {voice.status === 'connecting' && t('voice.connecting')}
          {voice.status === 'connected' && t('voice.connected')}
          {voice.status === 'error' && voice.error}
        </span>
      </div>

      <div className="voice-participants">
        <div className="voice-participant self">
          <span
            className="voice-avatar"
            style={{
              backgroundColor: ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'][
                actor.preferredUsername.charCodeAt(0) % 6
              ],
            }}
          >
            {actor.preferredUsername.charAt(0).toUpperCase()}
          </span>
          <span className="voice-participant-name">
            {actor.displayName ?? actor.preferredUsername}
          </span>
          {voice.micMuted && <span className="voice-mic-muted">🔇</span>}
        </div>

        {voice.peers.map((peer) => (
          <div
            key={peer.actorId}
            className={`voice-participant ${peer.connected ? 'connected' : 'pending'}`}
          >
            {peer.actor.avatarUrl ? (
              <img className="voice-avatar" src={peer.actor.avatarUrl} alt="" />
            ) : (
              <span
                className="voice-avatar"
                style={{
                  backgroundColor: ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'][
                    peer.actor.preferredUsername.charCodeAt(0) % 6
                  ],
                }}
              >
                {peer.actor.preferredUsername.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="voice-participant-name">
              {peer.actor.displayName ?? peer.actor.preferredUsername}
            </span>
          </div>
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
        <button className="voice-control-btn leave" onClick={onLeave}>
          {t('voice.leave')}
        </button>
      </div>
    </div>
  );
}
