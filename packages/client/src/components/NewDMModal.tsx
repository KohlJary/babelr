// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type React from 'react';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface NewDMModalProps {
  onStartDM: (participantId: string) => Promise<void>;
  onClose: () => void;
}

export function NewDMModal({ onStartDM, onClose }: NewDMModalProps) {
  const t = useT();
  const [users, setUsers] = useState<{ id: string; preferredUsername: string; displayName: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  useEffect(() => {
    api
      .getUsers()
      .then(setUsers)
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = async (userId: string) => {
    setSubmitting(userId);
    try {
      await onStartDM(userId);
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(null);
    }
  };

  const handleRemoteLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;
    setLookupError(null);
    setLookingUp(true);
    try {
      const user = await api.lookupUser(handle.trim());
      await onStartDM(user.id);
      onClose();
    } catch {
      setLookupError(t('friends.userNotFound'));
    } finally {
      setLookingUp(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('newDM.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleRemoteLookup} className="dm-remote-lookup">
          <input
            type="text"
            placeholder={t('newDM.lookupPlaceholder')}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={lookingUp}
          />
          <button type="submit" disabled={lookingUp || !handle.trim()}>
            {lookingUp ? '...' : t('common.find')}
          </button>
        </form>
        {lookupError && <div className="dm-lookup-error">{lookupError}</div>}
        <div className="discover-list">
          {loading && <div className="sidebar-empty">{t('newDM.loading')}</div>}
          {!loading && users.length === 0 && (
            <div className="sidebar-empty">{t('newDM.empty')}</div>
          )}
          {users.map((user) => (
            <div key={user.id} className="discover-item">
              <div className="discover-info">
                <span className="discover-name">
                  {user.displayName ?? user.preferredUsername}
                </span>
                <span className="discover-meta">@{user.preferredUsername}</span>
              </div>
              <button
                className="discover-join-btn"
                onClick={() => handleSelect(user.id)}
                disabled={submitting === user.id}
              >
                {submitting === user.id ? '...' : t('newDM.send')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
