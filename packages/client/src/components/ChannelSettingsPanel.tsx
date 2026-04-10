// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ChannelView } from '@babelr/shared';
import * as api from '../api';

interface ChannelSettingsPanelProps {
  channel: ChannelView;
  onClose: () => void;
  onUpdated?: (channel: ChannelView) => void;
}

export function ChannelSettingsPanel({ channel, onClose, onUpdated }: ChannelSettingsPanelProps) {
  const [name, setName] = useState(channel.name);
  const [category, setCategory] = useState(channel.category ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [description, setDescription] = useState(channel.description ?? '');
  const [slowMode, setSlowMode] = useState(String(channel.slowMode ?? 0));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const parsedSlow = Math.max(0, parseInt(slowMode || '0', 10) || 0);
      const updated = await api.updateChannel(channel.id, {
        name: name.trim(),
        category: category.trim() || null,
        topic: topic.trim() || null,
        description: description.trim() || null,
        slowMode: parsedSlow,
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
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Channel Settings</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-tab-content">
          <div className="settings-field">
            <label htmlFor="channel-name">Name</label>
            <input
              id="channel-name"
              className="modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="channel-category">Category</label>
            <input
              id="channel-category"
              className="modal-input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Leave blank for no category"
              maxLength={64}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="channel-topic">Topic</label>
            <input
              id="channel-topic"
              className="modal-input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="One-line topic shown in the channel header"
              maxLength={256}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="channel-description">Description</label>
            <textarea
              id="channel-description"
              className="modal-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Longer description — what's this channel about?"
              rows={5}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="channel-slowmode">Slow mode (seconds)</label>
            <input
              id="channel-slowmode"
              type="number"
              min={0}
              max={21600}
              className="modal-input"
              value={slowMode}
              onChange={(e) => setSlowMode(e.target.value)}
            />
            <p className="settings-hint">
              Minimum seconds between messages per user. 0 disables. Mods and admins bypass.
            </p>
          </div>

          <div className="settings-divider" />

          <button className="auth-submit" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          {status && <p className="settings-hint">{status}</p>}
        </div>
      </div>
    </div>
  );
}
