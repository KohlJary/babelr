// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ActorProfile } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface ProfilePanelProps {
  actor: ActorProfile;
  onUpdate: (updated: ActorProfile) => void;
  onClose: () => void;
}

function AvatarDisplay({ actor }: { actor: ActorProfile }) {
  if (actor.avatarUrl) {
    return <img className="profile-avatar-img" src={actor.avatarUrl} alt={actor.preferredUsername} />;
  }
  // Default: first letter in colored circle
  const colors = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'];
  const color = colors[actor.preferredUsername.charCodeAt(0) % colors.length];
  return (
    <div className="profile-avatar-default" style={{ backgroundColor: color }}>
      {actor.preferredUsername.charAt(0).toUpperCase()}
    </div>
  );
}

export function ProfilePanel({ actor, onUpdate, onClose }: ProfilePanelProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState(actor.displayName ?? '');
  const [bio, setBio] = useState(actor.summary ?? '');
  const [avatarUrl, setAvatarUrl] = useState(actor.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const updated = await api.updateProfile({
        displayName: displayName || undefined,
        summary: bio || undefined,
        avatarUrl: avatarUrl || undefined,
      });
      onUpdate(updated);
      setStatus(t('profile.saved'));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('profile.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!res.ok) throw new Error(t('profile.uploadFailed'));
      const data = await res.json();
      setAvatarUrl(data.url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('profile.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('profile.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="profile-avatar-section">
          <AvatarDisplay actor={{ ...actor, avatarUrl: avatarUrl || null }} />
          <div className="profile-avatar-actions">
            <label className="discover-join-btn" style={{ cursor: 'pointer' }}>
              {uploading ? '...' : t('profile.uploadAvatar')}
              <input
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                style={{ display: 'none' }}
              />
            </label>
            {avatarUrl && (
              <button className="logout-btn" onClick={() => setAvatarUrl('')}>
                {t('common.remove')}
              </button>
            )}
          </div>
        </div>

        <div className="settings-field">
          <label>{t('profile.username')}</label>
          <p className="settings-hint">@{actor.preferredUsername}</p>
        </div>

        <div className="settings-field">
          <label>{t('profile.displayName')}</label>
          <input
            type="text"
            placeholder={t('profile.displayNamePlaceholder')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="modal-input"
          />
        </div>

        <div className="settings-field">
          <label>{t('profile.bio')}</label>
          <textarea
            placeholder={t('profile.bioPlaceholder')}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="modal-input"
            rows={3}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {status && (
          <p className={`settings-hint ${status.includes('saved') || status === t('profile.saved') ? 'success' : 'error'}`}>
            {status}
          </p>
        )}

        <button className="auth-submit" onClick={handleSave} disabled={saving}>
          {saving ? '...' : t('profile.saveProfile')}
        </button>
      </div>
    </div>
  );
}
