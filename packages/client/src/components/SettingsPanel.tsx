// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { TranslationSettings } from '../translation';
import type { ActorProfile } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { SUPPORTED_LANGUAGES } from '@babelr/shared';
import { useOllamaModels } from '../hooks/useOllamaModels';
import { TwoFactorSettings } from './TwoFactorSettings';
import { TabbedView } from './TabbedView';

import { useTranslationSettings } from '../hooks/useTranslationSettings';

interface SettingsPanelProps {
  actor: ActorProfile;
  onClose: () => void;
  onActorUpdate?: (actor: ActorProfile) => void;
}

function AvatarDisplay({ actor }: { actor: ActorProfile }) {
  if (actor.avatarUrl) {
    return <img className="profile-avatar-img" src={actor.avatarUrl} alt={actor.preferredUsername} />;
  }
  const colors = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2'];
  const color = colors[actor.preferredUsername.charCodeAt(0) % colors.length];
  return (
    <div className="profile-avatar-default" style={{ backgroundColor: color }}>
      {actor.preferredUsername.charAt(0).toUpperCase()}
    </div>
  );
}

function ProfileTab({
  actor,
  onActorUpdate,
}: {
  actor: ActorProfile;
  onActorUpdate?: (a: ActorProfile) => void;
}) {
  const t = useT();
  const [displayName, setDisplayName] = useState(actor.displayName ?? '');
  const [bio, setBio] = useState(actor.summary ?? '');
  const [avatarUrl, setAvatarUrl] = useState(actor.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const updated = await api.updateProfile({
        displayName: displayName || undefined,
        summary: bio || undefined,
        avatarUrl: avatarUrl || undefined,
      });
      onActorUpdate?.(updated);
      setStatus(t('profile.saved'));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('profile.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) throw new Error(t('profile.uploadFailed'));
      const data = await res.json();
      setAvatarUrl(data.url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('profile.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="settings-tab-body">
      <div className="profile-avatar-section">
        <AvatarDisplay actor={{ ...actor, avatarUrl: avatarUrl || null }} />
        <div className="profile-avatar-actions">
          <label className="discover-join-btn" style={{ cursor: 'pointer' }}>
            {uploading ? '...' : t('profile.uploadAvatar')}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => void handleAvatarUpload(e)}
              style={{ display: 'none' }}
            />
          </label>
          {avatarUrl && (
            <button className="logout-btn" onClick={() => setAvatarUrl('')}>
              {t('common.remove')}
            </button>
          )}
        </div>
      </div>

      <div className="settings-field">
        <label>{t('profile.username')}</label>
        <p className="settings-hint">@{actor.preferredUsername}</p>
      </div>

      <div className="settings-field">
        <label>{t('profile.displayName')}</label>
        <input
          type="text"
          placeholder={t('profile.displayNamePlaceholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="modal-input"
        />
      </div>

      <div className="settings-field">
        <label>{t('profile.bio')}</label>
        <textarea
          placeholder={t('profile.bioPlaceholder')}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          className="modal-input"
          rows={3}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      {status && (
        <p className={`settings-hint ${status === t('profile.saved') ? 'success' : 'error'}`}>
          {status}
        </p>
      )}

      <button className="auth-submit" onClick={() => void handleSave()} disabled={saving}>
        {saving ? '...' : t('profile.saveProfile')}
      </button>
    </div>
  );
}

function TranslationTab({
  settings,
  onUpdate,
  onActorUpdate,
}: {
  settings: TranslationSettings;
  onUpdate: (partial: Partial<TranslationSettings>) => void;
  onActorUpdate?: (a: ActorProfile) => void;
}) {
  const t = useT();
  const ollama = useOllamaModels(
    settings.provider === 'ollama' ? settings.ollamaBaseUrl : '',
  );

  return (
    <div className="settings-tab-body">
      <div className="settings-field">
        <label>{t('settings.translationEngine')}</label>
        <div className="provider-group">
          <div className="provider-tier-label">{t('settings.tierTonePreserving')}</div>

          <label className="provider-option">
            <input type="radio" name="translation-provider" checked={settings.provider === 'anthropic'} onChange={() => onUpdate({ provider: 'anthropic' })} />
            <div className="provider-option-body">
              <div className="provider-option-title">{t('settings.providerAnthropic')}</div>
              <div className="provider-option-caption">{t('settings.providerAnthropicCaption')}</div>
            </div>
          </label>

          <label className="provider-option">
            <input type="radio" name="translation-provider" checked={settings.provider === 'openai'} onChange={() => onUpdate({ provider: 'openai' })} />
            <div className="provider-option-body">
              <div className="provider-option-title">{t('settings.providerOpenAI')}</div>
              <div className="provider-option-caption">{t('settings.providerOpenAICaption')}</div>
            </div>
          </label>

          <label className="provider-option">
            <input type="radio" name="translation-provider" checked={settings.provider === 'ollama'} onChange={() => onUpdate({ provider: 'ollama' })} />
            <div className="provider-option-body">
              <div className="provider-option-title">{t('settings.providerOllama')}</div>
              <div className="provider-option-caption">{t('settings.providerOllamaCaption')}</div>
            </div>
          </label>

          <div className="provider-tier-label">{t('settings.tierTranslationOnly')}</div>

          <label className="provider-option">
            <input type="radio" name="translation-provider" checked={settings.provider === 'local'} onChange={() => onUpdate({ provider: 'local' })} />
            <div className="provider-option-body">
              <div className="provider-option-title">{t('settings.providerLocal')}</div>
              <div className="provider-option-caption">{t('settings.providerLocalCaption')}</div>
            </div>
          </label>
        </div>
      </div>

      {settings.provider === 'anthropic' && (
        <div className="settings-field">
          <label>{t('settings.anthropicApiKey')}</label>
          <input type="password" placeholder="sk-ant-..." value={settings.anthropicApiKey} onChange={(e) => onUpdate({ anthropicApiKey: e.target.value })} />
          <p className="settings-hint">{t('settings.apiKeyHint')}</p>
        </div>
      )}

      {settings.provider === 'openai' && (
        <div className="settings-field">
          <label>{t('settings.openaiApiKey')}</label>
          <input type="password" placeholder="sk-..." value={settings.openaiApiKey} onChange={(e) => onUpdate({ openaiApiKey: e.target.value })} />
          <p className="settings-hint">{t('settings.apiKeyHint')}</p>
        </div>
      )}

      {settings.provider === 'ollama' && (
        <>
          <div className="settings-field">
            <label>{t('settings.ollamaBaseUrl')}</label>
            <input type="url" placeholder="http://localhost:11434" value={settings.ollamaBaseUrl} onChange={(e) => onUpdate({ ollamaBaseUrl: e.target.value })} />
            <p className="settings-hint">{t('settings.ollamaBaseUrlHint')}</p>
            {ollama.status === 'checking' && <p className="settings-hint">{t('settings.ollamaChecking')}</p>}
            {ollama.status === 'ok' && (
              <p className="settings-hint success">
                {ollama.models.length === 1
                  ? t('settings.ollamaConnectedOne')
                  : t('settings.ollamaConnected', { count: ollama.models.length })}
              </p>
            )}
            {ollama.status === 'empty' && <p className="settings-hint error">{t('settings.ollamaNoModels')}</p>}
            {ollama.status === 'error' && <p className="settings-hint error">{t('settings.ollamaUnreachable', { error: ollama.error ?? '' })}</p>}
          </div>
          <div className="settings-field">
            <label>{t('settings.ollamaModel')}</label>
            {ollama.status === 'ok' && ollama.models.length > 0 ? (
              <select
                value={ollama.models.includes(settings.ollamaModel) ? settings.ollamaModel : ollama.models[0]}
                onChange={(e) => onUpdate({ ollamaModel: e.target.value })}
              >
                {ollama.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input type="text" placeholder="llama3.1:8b" value={settings.ollamaModel} onChange={(e) => onUpdate({ ollamaModel: e.target.value })} />
            )}
            <p className="settings-hint">{t('settings.ollamaModelHint')}</p>
          </div>
        </>
      )}

      {settings.provider === 'local' && (
        <div className="settings-field">
          <p className="settings-hint">{t('settings.localModelHint')}</p>
        </div>
      )}

      <div className="settings-field">
        <label>{t('settings.readMessagesIn')}</label>
        <select
          value={settings.preferredLanguage}
          onChange={(e) => {
            const lang = e.target.value;
            onUpdate({ preferredLanguage: lang });
            api
              .updateProfile({ preferredLanguage: lang })
              .then((updated) => onActorUpdate?.(updated))
              .catch(() => {});
          }}
        >
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {t(`language.${code}` as 'language.en')}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
          />
          <span>{t('settings.enableTranslation')}</span>
        </label>
      </div>
    </div>
  );
}

function AccountTab({
  actor,
  onActorUpdate,
}: {
  actor: ActorProfile;
  onActorUpdate?: (a: ActorProfile) => void;
}) {
  const t = useT();
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwStatus, setPwStatus] = useState<string | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPw || !newPw) return;
    if (newPw.length < 12) {
      setPwStatus(t('settings.passwordTooShort'));
      return;
    }
    setPwSubmitting(true);
    setPwStatus(null);
    try {
      await api.changePassword(currentPw, newPw);
      setPwStatus(t('settings.passwordChanged'));
      setCurrentPw('');
      setNewPw('');
    } catch (err) {
      setPwStatus(err instanceof Error ? err.message : t('settings.passwordChangeFailed'));
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className="settings-tab-body">
      <form className="settings-field" onSubmit={(e) => void handlePasswordChange(e)} style={{ gap: '0.5rem' }}>
        <label>{t('settings.changePassword')}</label>
        <input type="password" placeholder={t('settings.currentPassword')} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="modal-input" />
        <input type="password" placeholder={t('settings.newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} className="modal-input" />
        {pwStatus && (
          <p className={`settings-hint ${pwStatus.includes('success') ? 'success' : 'error'}`}>{pwStatus}</p>
        )}
        <button type="submit" className="auth-submit" disabled={pwSubmitting || !currentPw || !newPw}>
          {pwSubmitting ? '...' : t('settings.updatePassword')}
        </button>
      </form>

      <div className="settings-divider" />
      <TwoFactorSettings actor={actor} onActorUpdate={onActorUpdate} />
    </div>
  );
}

export function SettingsPanel({ actor, onClose, onActorUpdate }: SettingsPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useTranslationSettings();

  const tabs = [
    { id: 'profile', label: t('settings.tabProfile') },
    { id: 'translation', label: t('settings.tabTranslation') },
    { id: 'account', label: t('settings.tabAccount') },
  ];

  return (
    <TabbedView
      title={t('settings.title')}
      tabs={tabs}
      onClose={onClose}
      renderContent={(tabId) => {
        switch (tabId) {
          case 'profile':
            return <ProfileTab actor={actor} onActorUpdate={onActorUpdate} />;
          case 'translation':
            return (
              <TranslationTab
                settings={settings}
                onUpdate={updateSettings}
                onActorUpdate={onActorUpdate}
              />
            );
          case 'account':
            return <AccountTab actor={actor} onActorUpdate={onActorUpdate} />;
          default:
            return null;
        }
      }}
    />
  );
}
