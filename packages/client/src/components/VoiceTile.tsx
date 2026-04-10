// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useRef } from 'react';
import type { AuthorView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface VoiceTileProps {
  actor: Pick<AuthorView, 'id' | 'preferredUsername' | 'displayName' | 'avatarUrl'>;
  stream: MediaStream | null;
  speaking: boolean;
  muted?: boolean;
  isSelf?: boolean;
  /** Tile is a screen share, not a webcam — shows a screen badge and uses 16:9 aspect. */
  isScreen?: boolean;
  // Remote-only: volume slider
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  // Connection indicator for remote peers
  connected?: boolean;
}

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'];

export function VoiceTile({
  actor,
  stream,
  speaking,
  muted,
  isSelf,
  isScreen,
  volume,
  onVolumeChange,
  connected,
}: VoiceTileProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Attach the stream to the <video> element via ref whenever it changes.
  // Self-view muted so we don't echo our own mic (we only use the video track).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    if (stream) {
      void el.play().catch(() => {
        /* autoplay policy — shouldn't hit this post-user-gesture */
      });
    }
  }, [stream]);

  const color = AVATAR_COLORS[actor.preferredUsername.charCodeAt(0) % AVATAR_COLORS.length];
  const label = actor.displayName ?? actor.preferredUsername;
  const hasVideo = stream !== null;

  return (
    <div
      className={`voice-tile ${isScreen ? 'screen' : ''} ${speaking ? 'speaking' : ''} ${connected === false ? 'pending' : ''}`}
    >
      {hasVideo && (
        <video
          ref={videoRef}
          className="voice-tile-video"
          autoPlay
          playsInline
          muted={isSelf === true}
        />
      )}
      {!hasVideo && (
        <div className="voice-tile-avatar-wrap">
          {actor.avatarUrl ? (
            <img className="voice-tile-avatar-img" src={actor.avatarUrl} alt="" />
          ) : (
            <span className="voice-tile-avatar-default" style={{ backgroundColor: color }}>
              {actor.preferredUsername.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
      )}

      <div className="voice-tile-overlay">
        <span className="voice-tile-name">
          {isScreen ? `🖥️ ${label}` : label}
        </span>
        {muted && <span className="voice-tile-badge" title={t('voice.youAreMuted')}>🔇</span>}
      </div>

      {onVolumeChange && typeof volume === 'number' && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          className="voice-tile-volume"
          title={t('voice.peerVolume')}
          aria-label={t('voice.peerVolume')}
        />
      )}
    </div>
  );
}
