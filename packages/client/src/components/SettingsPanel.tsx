// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { TranslationSettings } from '../translation';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { SUPPORTED_LANGUAGES } from '@babelr/shared';

interface SettingsPanelProps {
  settings: TranslationSettings;
  onUpdate: (partial: Partial<TranslationSettings>) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onUpdate, onClose }: SettingsPanelProps) {
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
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-field">
          <label>{t('settings.translationEngine')}</label>
          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${settings.provider === 'anthropic' ? 'active' : ''}`}
              onClick={() => onUpdate({ provider: 'anthropic' })}
            >
              {t('settings.cloudClaude')}
            </button>
            <button
              type="button"
              className={`auth-tab ${settings.provider === 'local' ? 'active' : ''}`}
              onClick={() => onUpdate({ provider: 'local' })}
            >
              {t('settings.localBrowser')}
            </button>
          </div>
        </div>

        {settings.provider === 'anthropic' && (
          <div className="settings-field">
            <label>{t('settings.anthropicApiKey')}</label>
            <input
              type="password"
              placeholder="sk-ant-..."
              value={settings.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
            <p className="settings-hint">{t('settings.apiKeyHint')}</p>
          </div>
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
            onChange={(e) => onUpdate({ preferredLanguage: e.target.value })}
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

        <div className="settings-divider" />

        <form className="settings-field" onSubmit={handlePasswordChange} style={{ gap: '0.5rem' }}>
          <label>{t('settings.changePassword')}</label>
          <input
            type="password"
            placeholder={t('settings.currentPassword')}
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            className="modal-input"
          />
          <input
            type="password"
            placeholder={t('settings.newPassword')}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            className="modal-input"
          />
          {pwStatus && (
            <p className={`settings-hint ${pwStatus.includes('success') ? 'success' : 'error'}`}>
              {pwStatus}
            </p>
          )}
          <button type="submit" className="auth-submit" disabled={pwSubmitting || !currentPw || !newPw}>
            {pwSubmitting ? '...' : t('settings.updatePassword')}
          </button>
        </form>
      </div>
    </div>
  );
}
