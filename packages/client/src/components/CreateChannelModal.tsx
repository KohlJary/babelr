// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';

interface CreateChannelModalProps {
  onCreateChannel: (name: string) => Promise<void>;
  onClose: () => void;
}

export function CreateChannelModal({ onCreateChannel, onClose }: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreateChannel(name.trim());
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
          <h2>Create Channel</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="settings-field" style={{ gap: '0.75rem' }}>
          <input
            type="text"
            placeholder="Channel name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="modal-input"
          />
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? '...' : 'Create'}
          </button>
        </form>
      </div>
    </div>
  );
}
