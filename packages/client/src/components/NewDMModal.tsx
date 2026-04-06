// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import * as api from '../api';

interface NewDMModalProps {
  onStartDM: (participantId: string) => Promise<void>;
  onClose: () => void;
}

export function NewDMModal({ onStartDM, onClose }: NewDMModalProps) {
  const [users, setUsers] = useState<{ id: string; preferredUsername: string; displayName: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);

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

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>New Message</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="discover-list">
          {loading && <div className="sidebar-empty">Loading users...</div>}
          {!loading && users.length === 0 && (
            <div className="sidebar-empty">No other users yet</div>
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
                {submitting === user.id ? '...' : 'Message'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
