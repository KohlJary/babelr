// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import * as api from '../api';

interface CreateServerModalProps {
  onCreateServer: (name: string, description?: string) => Promise<void>;
  onJoinServer: (serverId: string) => Promise<void>;
  onClose: () => void;
}

export function CreateServerModal({
  onCreateServer,
  onJoinServer,
  onClose,
}: CreateServerModalProps) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [discoverable, setDiscoverable] = useState<api.DiscoverableServer[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);

  useEffect(() => {
    if (mode === 'join') {
      setLoadingServers(true);
      api
        .discoverServers()
        .then(setDiscoverable)
        .finally(() => setLoadingServers(false));
    }
  }, [mode]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreateServer(name, description || undefined);
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (serverId: string) => {
    setSubmitting(true);
    try {
      await onJoinServer(serverId);
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{mode === 'create' ? 'Create Server' : 'Join Server'}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'create' ? 'active' : ''}`}
            onClick={() => setMode('create')}
          >
            Create
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'join' ? 'active' : ''}`}
            onClick={() => setMode('join')}
          >
            Join
          </button>
        </div>

        {mode === 'create' ? (
          <form onSubmit={handleCreate} className="settings-field" style={{ gap: '0.75rem' }}>
            <input
              type="text"
              placeholder="Server name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="modal-input"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="modal-input"
            />
            <button type="submit" className="auth-submit" disabled={submitting}>
              {submitting ? '...' : 'Create'}
            </button>
          </form>
        ) : (
          <div className="discover-list">
            {loadingServers && <div className="sidebar-empty">Loading servers...</div>}
            {!loadingServers && discoverable.length === 0 && (
              <div className="sidebar-empty">No servers available</div>
            )}
            {discoverable.map((server) => (
              <div key={server.id} className="discover-item">
                <div className="discover-info">
                  <span className="discover-name">{server.name}</span>
                  <span className="discover-meta">
                    {server.memberCount} member{server.memberCount !== 1 ? 's' : ''}
                    {server.description ? ` \u2014 ${server.description}` : ''}
                  </span>
                </div>
                {server.joined ? (
                  <span className="discover-joined">Joined</span>
                ) : (
                  <button
                    className="discover-join-btn"
                    onClick={() => handleJoin(server.id)}
                    disabled={submitting}
                  >
                    Join
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
