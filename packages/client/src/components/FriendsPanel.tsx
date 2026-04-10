// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type React from 'react';
import { useFriends } from '../hooks/useFriends';

interface FriendsPanelProps {
  onStartDM: (actorId: string) => Promise<void>;
  onClose: () => void;
}

export function FriendsPanel({ onStartDM, onClose }: FriendsPanelProps) {
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
      setAddError(err instanceof Error ? err.message : 'Failed to add friend');
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
          <h2>Friends</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleAdd} className="dm-remote-lookup">
          <input
            type="text"
            placeholder="Add friend by handle: user@domain"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={adding}
          />
          <button type="submit" disabled={adding || !handle.trim()}>
            {adding ? '...' : 'Add'}
          </button>
        </form>
        {addError && <div className="dm-lookup-error">{addError}</div>}

        {loading && <div className="sidebar-empty">Loading...</div>}
        {error && <div className="dm-lookup-error">{error}</div>}

        {!loading && incoming.length > 0 && (
          <div className="friends-section">
            <h3 className="friends-section-header">Incoming requests</h3>
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
                    Accept
                  </button>
                  <button
                    className="friends-btn decline"
                    onClick={() => doAction(f.id, () => removeFriend(f.id))}
                    disabled={pendingAction === f.id}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && outgoing.length > 0 && (
          <div className="friends-section">
            <h3 className="friends-section-header">Sent requests</h3>
            {outgoing.map((f) => (
              <div key={f.id} className="friends-row">
                <div className="friends-identity">
                  <span className="friends-name">{f.other.displayName ?? f.other.preferredUsername}</span>
                  <span className="friends-handle">@{f.other.preferredUsername}</span>
                </div>
                <div className="friends-actions">
                  <span className="friends-pending">Pending</span>
                  <button
                    className="friends-btn decline"
                    onClick={() => doAction(f.id, () => removeFriend(f.id))}
                    disabled={pendingAction === f.id}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="friends-section">
          <h3 className="friends-section-header">Friends ({accepted.length})</h3>
          {!loading && accepted.length === 0 && (
            <div className="sidebar-empty">No friends yet — add one above.</div>
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
                  Message
                </button>
                <button
                  className="friends-btn decline"
                  onClick={() => doAction(f.id, () => removeFriend(f.id))}
                  disabled={pendingAction === f.id}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
