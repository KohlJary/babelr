// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';

interface CreateChannelModalProps {
  onCreateChannel: (
    name: string,
    category?: string,
    isPrivate?: boolean,
    channelType?: 'text' | 'voice',
  ) => Promise<void>;
  onClose: () => void;
}

export function CreateChannelModal({ onCreateChannel, onClose }: CreateChannelModalProps) {
  const t = useT();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isVoice, setIsVoice] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreateChannel(
        name.trim(),
        category.trim() || undefined,
        isPrivate || undefined,
        isVoice ? 'voice' : 'text',
      );
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
          <h2>{t('createChannel.titleHeading')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="settings-field" style={{ gap: '0.75rem' }}>
          <input
            type="text"
            placeholder={t('createChannel.channelNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="modal-input"
          />
          <input
            type="text"
            placeholder={t('createChannel.categoryPlaceholder')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="modal-input"
          />
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={isVoice}
              onChange={(e) => setIsVoice(e.target.checked)}
            />
            <span>{t('createChannel.voiceChannel')}</span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <span>{t('createChannel.privateChannelInviteOnly')}</span>
          </label>
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? '...' : t('createChannel.create')}
          </button>
        </form>
      </div>
    </div>
  );
}
