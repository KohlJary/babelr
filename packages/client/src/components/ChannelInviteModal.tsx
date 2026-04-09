// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import * as api from '../api';

interface ChannelInviteModalProps {
  channelId: string;
  onClose: () => void;
}

export function ChannelInviteModal({ channelId, onClose }: ChannelInviteModalProps) {
  const [users, setUsers] = useState<{ id: string; preferredUsername: string; displayName: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getUsers().then(setUsers).finally(() => setLoading(false));
  }, []);

  const handleInvite = async (userId: string) => {
    setInviting(userId);
    try {
      await api.inviteToChannel(channelId, userId);
      setInvited((prev) => new Set([...prev, userId]));
    } finally {
      setInviting(null);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Invite to Channel</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="discover-list">
          {loading && <div className="sidebar-empty">Loading...</div>}
          {users.map((user) => (
            <div key={user.id} className="discover-item">
              <div className="discover-info">
                <span className="discover-name">{user.displayName ?? user.preferredUsername}</span>
                <span className="discover-meta">@{user.preferredUsername}</span>
              </div>
              {invited.has(user.id) ? (
                <span className="discover-joined">Invited</span>
              ) : (
                <button
                  className="discover-join-btn"
                  onClick={() => handleInvite(user.id)}
                  disabled={inviting === user.id}
                >
                  {inviting === user.id ? '...' : 'Invite'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
