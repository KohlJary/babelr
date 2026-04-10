// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type React from 'react';
import { useFriends } from '../hooks/useFriends';
import { useT } from '../i18n/I18nProvider';

interface FriendsPanelProps {
  onStartDM: (actorId: string) => Promise<void>;
  onClose: () => void;
}

export function FriendsPanel({ onStartDM, onClose }: FriendsPanelProps) {
  const t = useT();
  const { friendships, loading, error, addFriend, acceptFriend, removeFriend } = useFriends();
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const incoming = friendships.filter((f) => f.state === 'pending_in');
  const outgoing = friendships.filter((f) => f.state === 'pending_out');
  const accepted = friendships.filter((f) => f.state === 'accepted');

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;
    setAddError(null);
    setAdding(true);
    try {
      await addFriend(handle.trim());
      setHandle('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('friends.failedToAdd'));
    } finally {
      setAdding(false);
    }
  };

  const doAction = async (id: string, action: () => Promise<unknown>) => {
    setPendingAction(id);
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('friends.title')}</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleAdd} className="dm-remote-lookup">
          <input
            type="text"
            placeholder={t('friends.addByHandle')}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={adding}
          />
          <button type="submit" disabled={adding || !handle.trim()}>
            {adding ? '...' : t('friends.add')}
          </button>
        </form>
        {addError && <div className="dm-lookup-error">{addError}</div>}

        {loading && <div className="sidebar-empty">{t('common.loading')}</div>}
        {error && <div className="dm-lookup-error">{error}</div>}

        {!loading && incoming.length > 0 && (
          <div className="friends-section">
            <h3 className="friends-section-header">{t('friends.incomingRequests')}</h3>
            {incoming.map((f) => (
              <div key={f.id} className="friends-row">
                <div className="friends-identity">
                  <span className="friends-name">{f.other.displayName ?? f.other.preferredUsername}</span>
                  <span className="friends-handle">@{f.other.preferredUsername}</span>
                </div>
                <div className="friends-actions">
                  <button
                    className="friends-btn accept"
                    onClick={() => doAction(f.id, () => acceptFriend(f.id))}
                    disabled={pendingAction === f.id}
                  >
                    {t('friends.accept')}
                  </button>
                  <button
                    className="friends-btn decline"
                    onClick={() => doAction(f.id, () => removeFriend(f.id))}
                    disabled={pendingAction === f.id}
                  >
                    {t('friends.decline')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && outgoing.length > 0 && (
          <div className="friends-section">
            <h3 className="friends-section-header">{t('friends.sentRequests')}</h3>
            {outgoing.map((f) => (
              <div key={f.id} className="friends-row">
                <div className="friends-identity">
                  <span className="friends-name">{f.other.displayName ?? f.other.preferredUsername}</span>
                  <span className="friends-handle">@{f.other.preferredUsername}</span>
                </div>
                <div className="friends-actions">
                  <span className="friends-pending">{t('friends.pending')}</span>
                  <button
                    className="friends-btn decline"
                    onClick={() => doAction(f.id, () => removeFriend(f.id))}
                    disabled={pendingAction === f.id}
                  >
                    {t('friends.cancel')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="friends-section">
          <h3 className="friends-section-header">{t('friends.friendsCount')} ({accepted.length})</h3>
          {!loading && accepted.length === 0 && (
            <div className="sidebar-empty">{t('friends.empty')}</div>
          )}
          {accepted.map((f) => (
            <div key={f.id} className="friends-row">
              <div className="friends-identity">
                <span className="friends-name">{f.other.displayName ?? f.other.preferredUsername}</span>
                <span className="friends-handle">@{f.other.preferredUsername}</span>
              </div>
              <div className="friends-actions">
                <button
                  className="friends-btn accept"
                  onClick={() =>
                    doAction(f.id, async () => {
                      await onStartDM(f.other.id);
                      onClose();
                    })
                  }
                  disabled={pendingAction === f.id}
                >
                  {t('friends.message')}
                </button>
                <button
                  className="friends-btn decline"
                  onClick={() => doAction(f.id, () => removeFriend(f.id))}
                  disabled={pendingAction === f.id}
                >
                  {t('friends.remove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
