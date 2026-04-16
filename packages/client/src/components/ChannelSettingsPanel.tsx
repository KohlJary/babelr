// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ChannelView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { TabbedView } from './TabbedView';

interface ChannelSettingsPanelProps {
  channel: ChannelView;
  onClose: () => void;
  onUpdated?: (channel: ChannelView) => void;
}

function GeneralTab({
  channel,
  onUpdated,
}: {
  channel: ChannelView;
  onUpdated?: (c: ChannelView) => void;
}) {
  const t = useT();
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
      setStatus(t('common.saved'));
      onUpdated?.(updated);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('channelSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab-body">
      <div className="settings-field">
        <label htmlFor="channel-name">{t('channelSettings.name')}</label>
        <input id="channel-name" className="modal-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>

      <div className="settings-field">
        <label htmlFor="channel-category">{t('channelSettings.category')}</label>
        <input id="channel-category" className="modal-input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('channelSettings.categoryHint')} maxLength={64} />
      </div>

      <div className="settings-field">
        <label htmlFor="channel-topic">{t('channelSettings.topic')}</label>
        <input id="channel-topic" className="modal-input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t('channelSettings.topicHint')} maxLength={256} />
      </div>

      <div className="settings-field">
        <label htmlFor="channel-description">{t('channelSettings.description')}</label>
        <textarea id="channel-description" className="modal-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('channelSettings.descriptionHint')} rows={5} />
      </div>

      <div className="settings-field">
        <label htmlFor="channel-slowmode">{t('channelSettings.slowMode')}</label>
        <input id="channel-slowmode" type="number" min={0} max={21600} className="modal-input" value={slowMode} onChange={(e) => setSlowMode(e.target.value)} />
        <p className="settings-hint">{t('channelSettings.slowModeHint')}</p>
      </div>

      <div className="settings-divider" />

      <button className="auth-submit" onClick={() => void handleSave()} disabled={saving}>
        {saving ? t('common.saving') : t('common.saveChanges')}
      </button>
      {status && <p className="settings-hint">{status}</p>}
    </div>
  );
}

export function ChannelSettingsPanel({ channel, onClose, onUpdated }: ChannelSettingsPanelProps) {
  const t = useT();

  const tabs = [
    { id: 'general', label: t('channelSettings.tabGeneral') },
  ];

  return (
    <TabbedView
      title={`${t('channelSettings.title')} · #${channel.name}`}
      tabs={tabs}
      onClose={onClose}
      renderContent={(tabId) => {
        switch (tabId) {
          case 'general':
            return <GeneralTab channel={channel} onUpdated={onUpdated} />;
          default:
            return null;
        }
      }}
    />
  );
}
