// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

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
  const t = useT();
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
          <h2>{mode === 'create' ? t('createServer.createTitle') : t('createServer.joinTitle')}</h2>
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
            {t('createServer.create')}
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'join' ? 'active' : ''}`}
            onClick={() => setMode('join')}
          >
            {t('createServer.join')}
          </button>
        </div>

        {mode === 'create' ? (
          <form onSubmit={handleCreate} className="settings-field" style={{ gap: '0.75rem' }}>
            <input
              type="text"
              placeholder={t('createServer.serverNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="modal-input"
            />
            <input
              type="text"
              placeholder={t('createServer.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="modal-input"
            />
            <button type="submit" className="auth-submit" disabled={submitting}>
              {submitting ? '...' : t('createServer.create')}
            </button>
          </form>
        ) : (
          <div className="discover-list">
            {loadingServers && <div className="sidebar-empty">{t('createServer.loadingServers')}</div>}
            {!loadingServers && discoverable.length === 0 && (
              <div className="sidebar-empty">{t('createServer.noServersAvailable')}</div>
            )}
            {discoverable.map((server) => (
              <div key={server.id} className="discover-item">
                <div className="discover-info">
                  <span className="discover-name">{server.name}</span>
                  <span className="discover-meta">
                    {server.memberCount}{' '}
                    {server.memberCount === 1
                      ? t('createServer.memberOne')
                      : t('createServer.memberMany')}
                    {server.description ? ` \u2014 ${server.description}` : ''}
                  </span>
                </div>
                {server.joined ? (
                  <span className="discover-joined">{t('createServer.joined')}</span>
                ) : (
                  <button
                    className="discover-join-btn"
                    onClick={() => handleJoin(server.id)}
                    disabled={submitting}
                  >
                    {t('createServer.join')}
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
