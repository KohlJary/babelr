// SPDX-License-Identifier: MIT
import type { UseVoiceState } from '../hooks/useVoice';
import { useT } from '../i18n/I18nProvider';

interface VoiceJoinBarProps {
  voice: UseVoiceState;
  /** The failure from the last join attempt of this channel, if any. */
  joinError: { message: string; kind?: UseVoiceState['errorKind'] } | null;
  onJoin: () => void;
}

/**
 * Shown in a voice channel you're not in: why the last join failed (no
 * mic, no permission, a server error) and a button to try again
 * (FINDINGS #68). Before this a failed join left an empty text channel
 * with no error and no way back in.
 */
export function VoiceJoinBar({ voice, joinError, onJoin }: VoiceJoinBarProps) {
  const t = useT();
  const connecting = voice.status === 'connecting';
  let detail: string | null = null;
  if (joinError) {
    detail =
      joinError.kind === 'mic-denied'
        ? t('voice.micPermissionDenied')
        : joinError.kind === 'mic-missing'
          ? t('voice.micMissing')
          : joinError.kind === 'mic-insecure'
            ? t('voice.micInsecure')
            : joinError.kind === 'mic-unavailable'
              ? t('voice.micUnavailable', { error: joinError.message })
              : t('voice.joinError', { error: joinError.message });
  }
  return (
    <div
      className={`voice-join-bar${joinError ? ' error' : ''}`}
      role={joinError ? 'alert' : undefined}
    >
      <div className="voice-join-bar-text">
        {joinError ? (
          <>
            <strong>{t('voice.joinFailed')}</strong> {detail}
          </>
        ) : connecting ? (
          t('voice.connecting')
        ) : (
          t('voice.notJoined')
        )}
      </div>
      <button type="button" className="voice-join-bar-btn" onClick={onJoin} disabled={connecting}>
        {joinError ? t('voice.retry') : t('voice.join')}
      </button>
    </div>
  );
}
