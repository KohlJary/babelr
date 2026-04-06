// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';

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
  const [serverId, setServerId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === 'create') {
        await onCreateServer(name, description || undefined);
      } else {
        await onJoinServer(serverId);
      }
      onClose();
    } catch {
      // Error handling could be added
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

        <form onSubmit={handleSubmit} className="settings-field" style={{ gap: '0.75rem' }}>
          {mode === 'create' ? (
            <>
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
            </>
          ) : (
            <input
              type="text"
              placeholder="Server ID"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              required
              className="modal-input"
            />
          )}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? '...' : mode === 'create' ? 'Create' : 'Join'}
          </button>
        </form>
      </div>
    </div>
  );
}
