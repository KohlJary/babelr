// SPDX-License-Identifier: Hippocratic-3.0
import { useT } from '../i18n/I18nProvider';
import type { UseVoiceState } from '../hooks/useVoice';

interface VoiceControlsProps {
  voice: UseVoiceState;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onTogglePushToTalk: () => void;
  onToggleVideo: () => void | Promise<void>;
  onToggleScreenShare: () => void | Promise<void>;
}

/**
 * Bottom button bar for in-call controls. Shared between the floating
 * VoicePanel widget and the full-size CallView so they stay visually
 * and behaviorally aligned.
 */
export function VoiceControls({
  voice,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onTogglePushToTalk,
  onToggleVideo,
  onToggleScreenShare,
}: VoiceControlsProps) {
  const t = useT();
  return (
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
  );
}
