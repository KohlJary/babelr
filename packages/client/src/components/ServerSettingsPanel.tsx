// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type React from 'react';
import type { ServerView } from '@babelr/shared';
import * as api from '../api';

type Tab = 'info' | 'invites';

interface ServerSettingsPanelProps {
  server: ServerView;
  onClose: () => void;
  onUpdated?: (server: ServerView) => void;
}

export function ServerSettingsPanel({ server, onClose, onUpdated }: ServerSettingsPanelProps) {
  const [tab, setTab] = useState<Tab>('info');

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Server Settings</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'info' ? 'active' : ''}`}
            onClick={() => setTab('info')}
          >
            Info
          </button>
          <button
            className={`settings-tab ${tab === 'invites' ? 'active' : ''}`}
            onClick={() => setTab('invites')}
          >
            Invites
          </button>
        </div>

        {tab === 'info' && <InfoTab server={server} onUpdated={onUpdated} />}
        {tab === 'invites' && <InvitesTab serverId={server.id} />}
      </div>
    </div>
  );
}

function InfoTab({
  server,
  onUpdated,
}: {
  server: ServerView;
  onUpdated?: (server: ServerView) => void;
}) {
  const [name, setName] = useState(server.name);
  const [tagline, setTagline] = useState(server.tagline ?? '');
  const [longDescription, setLongDescription] = useState(server.longDescription ?? '');
  const [logoUrl, setLogoUrl] = useState(server.logoUrl ?? '');
  const [tags, setTags] = useState<string[]>(server.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    if (t.length > 32) {
      setStatus('Tags must be 32 characters or fewer');
      return;
    }
    if (tags.includes(t)) {
      setTagInput('');
      return;
    }
    if (tags.length >= 10) {
      setStatus('Maximum 10 tags');
      return;
    }
    setTags((prev) => [...prev, t]);
    setTagInput('');
    setStatus(null);
  };

  const removeTag = (t: string) => {
    setTags((prev) => prev.filter((x) => x !== t));
  };

  const handleTagKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setLogoUrl(data.url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const updated = await api.updateServer(server.id, {
        name: name.trim(),
        tagline: tagline.trim() || null,
        longDescription: longDescription.trim() || null,
        logoUrl: logoUrl || null,
        tags,
      });
      setStatus('Saved');
      onUpdated?.(updated);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-field">
        <label>Logo</label>
        <div className="server-logo-row">
          {logoUrl ? (
            <img src={logoUrl} alt="Server logo" className="server-logo-preview" />
          ) : (
            <div className="server-logo-placeholder">No logo</div>
          )}
          <div className="server-logo-actions">
            <label className="auth-submit server-logo-upload-btn">
              {uploading ? 'Uploading...' : 'Upload image'}
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                disabled={uploading}
                style={{ display: 'none' }}
              />
            </label>
            {logoUrl && (
              <button className="friends-btn decline" onClick={() => setLogoUrl('')}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="settings-field">
        <label htmlFor="server-name">Name</label>
        <input
          id="server-name"
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
      </div>

      <div className="settings-field">
        <label htmlFor="server-tagline">Tagline</label>
        <input
          id="server-tagline"
          className="modal-input"
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          placeholder="A short one-liner about your server"
          maxLength={140}
        />
        <p className="settings-hint">Shown on discovery cards and invite landing pages.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="server-long-description">About</label>
        <textarea
          id="server-long-description"
          className="modal-input"
          value={longDescription}
          onChange={(e) => setLongDescription(e.target.value)}
          placeholder="Longer description — what's this server about? Who's it for?"
          rows={6}
        />
      </div>

      <div className="settings-field">
        <label>Tags</label>
        <div className="server-tags-row">
          {tags.map((t) => (
            <span key={t} className="server-tag">
              {t}
              <button className="server-tag-remove" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <input
            className="modal-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKey}
            placeholder="Add tag (press Enter)"
            maxLength={32}
            style={{ flex: 1 }}
          />
          <button className="friends-btn" onClick={addTag} disabled={!tagInput.trim()}>
            Add
          </button>
        </div>
        <p className="settings-hint">Up to 10 tags. Used for discoverability.</p>
      </div>

      <div className="settings-divider" />

      <button className="auth-submit" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save changes'}
      </button>
      {status && <p className="settings-hint">{status}</p>}
    </div>
  );
}

function InvitesTab({ serverId }: { serverId: string }) {
  const [invites, setInvites] = useState<api.InviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('');

  useEffect(() => {
    api.listServerInvites(serverId).then(setInvites).finally(() => setLoading(false));
  }, [serverId]);

  const createInvite = async () => {
    setCreating(true);
    try {
      const invite = await api.createServerInvite(serverId, {
        maxUses: maxUses ? parseInt(maxUses, 10) : undefined,
        expiresInHours: expiresHours ? parseInt(expiresHours, 10) : undefined,
      });
      setInvites((prev) => [
        ...prev,
        {
          code: invite.code,
          url: invite.url,
          maxUses: maxUses ? parseInt(maxUses, 10) : null,
          uses: 0,
          expiresAt: expiresHours
            ? new Date(Date.now() + parseInt(expiresHours, 10) * 3600000).toISOString()
            : null,
          createdAt: new Date().toISOString(),
        },
      ]);
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
    <div className="settings-tab-content">
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
                  <span className="discover-name" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {inv.code}
                  </span>
                  <span className="discover-meta">
                    {inv.uses}
                    {inv.maxUses ? `/${inv.maxUses}` : ''} uses
                    {inv.expiresAt ? ` \u00B7 expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ''}
                  </span>
                </div>
                <button className="discover-join-btn" onClick={() => copyLink(inv.url)}>
                  Copy
                </button>
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
  );
}
