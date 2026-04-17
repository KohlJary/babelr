// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef } from 'react';
import type { UserProfile } from '../api';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface ProfileCardProps {
  userId: string;
  anchorRect?: DOMRect;
  onClose: () => void;
  onStartDM?: (userId: string) => void;
}

export function ProfileCard({ userId, anchorRect, onClose, onStartDM }: ProfileCardProps) {
  const t = useT();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getUserProfile(userId).then(setProfile).catch(() => {}).finally(() => setLoading(false));
  }, [userId]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Position near the anchor
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = 'fixed';
    style.top = anchorRect.bottom + 4;
    style.left = Math.min(anchorRect.left, window.innerWidth - 300);
    style.zIndex = 200;
  }

  if (loading) {
    return (
      <div ref={cardRef} className="profile-card" style={style}>
        <div className="profile-card-loading">{t('common.loading')}</div>
      </div>
    );
  }

  if (!profile) {
    onClose();
    return null;
  }

  const colors = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'];
  const avatarColor = colors[profile.preferredUsername.charCodeAt(0) % colors.length];

  return (
    <div ref={cardRef} className="profile-card" style={style}>
      <div className="profile-card-header">
        {profile.avatarUrl ? (
          <img className="profile-card-avatar" src={profile.avatarUrl} alt="" />
        ) : (
          <div className="profile-card-avatar-default" style={{ backgroundColor: avatarColor }}>
            {profile.preferredUsername.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="profile-card-identity">
          <span className="profile-card-name">
            {profile.displayName ?? profile.preferredUsername}
          </span>
          <span className="profile-card-handle">@{profile.preferredUsername}</span>
        </div>
      </div>

      {profile.summary && (
        <div className="profile-card-bio">{profile.summary}</div>
      )}

      <div className="profile-card-meta">
        <span>{t('profileCard.memberSince')} {new Date(profile.createdAt).toLocaleDateString()}</span>
      </div>

      {profile.mutualServers.length > 0 && (
        <div className="profile-card-mutual">
          <span className="profile-card-mutual-label">
            {t('profileCard.mutualServers')} ({profile.mutualServers.length})
          </span>
          <div className="profile-card-mutual-list">
            {profile.mutualServers.map((s) => (
              <span key={s.id} className="profile-card-server-chip">{s.name}</span>
            ))}
          </div>
        </div>
      )}

      <div className="profile-card-actions">
        {onStartDM && (
          <button
            className="profile-card-btn primary"
            onClick={() => { onStartDM(profile.id); onClose(); }}
          >
            {t('profileCard.sendMessage')}
          </button>
        )}
        <button className="profile-card-btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
