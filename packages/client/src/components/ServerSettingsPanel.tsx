// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { ServerView } from '@babelr/shared';
import * as api from '../api';

interface ServerSettingsPanelProps {
  server: ServerView;
  onClose: () => void;
}

export function ServerSettingsPanel({ server, onClose }: ServerSettingsPanelProps) {
  const [invites, setInvites] = useState<api.InviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('');

  useEffect(() => {
    api.listServerInvites(server.id).then(setInvites).finally(() => setLoading(false));
  }, [server.id]);

  const createInvite = async () => {
    setCreating(true);
    try {
      const invite = await api.createServerInvite(server.id, {
        maxUses: maxUses ? parseInt(maxUses, 10) : undefined,
        expiresInHours: expiresHours ? parseInt(expiresHours, 10) : undefined,
      });
      setInvites((prev) => [...prev, {
        code: invite.code,
        url: invite.url,
        maxUses: maxUses ? parseInt(maxUses, 10) : null,
        uses: 0,
        expiresAt: expiresHours ? new Date(Date.now() + parseInt(expiresHours, 10) * 3600000).toISOString() : null,
        createdAt: new Date().toISOString(),
      }]);
      setMaxUses('');
      setExpiresHours('');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Server Settings</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-field">
          <label>{server.name}</label>
          <p className="settings-hint">{server.description ?? 'No description'} &middot; {server.memberCount} members</p>
        </div>

        <div className="settings-divider" />

        <div className="settings-field">
          <label>Invite Links</label>
        </div>

        {loading ? (
          <div className="sidebar-empty">Loading...</div>
        ) : (
          <>
            <div className="discover-list" style={{ maxHeight: '200px' }}>
              {invites.length === 0 && <div className="sidebar-empty">No invite links yet</div>}
              {invites.map((inv) => (
                <div key={inv.code} className="discover-item">
                  <div className="discover-info">
                    <span className="discover-name" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{inv.code}</span>
                    <span className="discover-meta">
                      {inv.uses}{inv.maxUses ? `/${inv.maxUses}` : ''} uses
                      {inv.expiresAt ? ` \u00B7 expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ''}
                    </span>
                  </div>
                  <button className="discover-join-btn" onClick={() => copyLink(inv.url)}>Copy</button>
                </div>
              ))}
            </div>

            <div className="settings-divider" />

            <div className="settings-field" style={{ gap: '0.5rem' }}>
              <label>Create Invite</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  className="modal-input"
                  placeholder="Max uses (optional)"
                  type="number"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  style={{ flex: 1 }}
                />
                <input
                  className="modal-input"
                  placeholder="Expires in hours"
                  type="number"
                  value={expiresHours}
                  onChange={(e) => setExpiresHours(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              <button className="auth-submit" onClick={createInvite} disabled={creating}>
                {creating ? '...' : 'Create Invite Link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
