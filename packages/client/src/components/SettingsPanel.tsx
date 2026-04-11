// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { TranslationSettings } from '../translation';
import type { ActorProfile } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { SUPPORTED_LANGUAGES } from '@babelr/shared';

interface SettingsPanelProps {
  settings: TranslationSettings;
  onUpdate: (partial: Partial<TranslationSettings>) => void;
  onClose: () => void;
  onActorUpdate?: (actor: ActorProfile) => void;
}

export function SettingsPanel({ settings, onUpdate, onClose, onActorUpdate }: SettingsPanelProps) {
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
          <div className="provider-group">
            <div className="provider-tier-label">{t('settings.tierTonePreserving')}</div>

            <label className="provider-option">
              <input
                type="radio"
                name="translation-provider"
                checked={settings.provider === 'anthropic'}
                onChange={() => onUpdate({ provider: 'anthropic' })}
              />
              <div className="provider-option-body">
                <div className="provider-option-title">{t('settings.providerAnthropic')}</div>
                <div className="provider-option-caption">{t('settings.providerAnthropicCaption')}</div>
              </div>
            </label>

            <label className="provider-option">
              <input
                type="radio"
                name="translation-provider"
                checked={settings.provider === 'openai'}
                onChange={() => onUpdate({ provider: 'openai' })}
              />
              <div className="provider-option-body">
                <div className="provider-option-title">{t('settings.providerOpenAI')}</div>
                <div className="provider-option-caption">{t('settings.providerOpenAICaption')}</div>
              </div>
            </label>

            <label className="provider-option">
              <input
                type="radio"
                name="translation-provider"
                checked={settings.provider === 'ollama'}
                onChange={() => onUpdate({ provider: 'ollama' })}
              />
              <div className="provider-option-body">
                <div className="provider-option-title">{t('settings.providerOllama')}</div>
                <div className="provider-option-caption">{t('settings.providerOllamaCaption')}</div>
              </div>
            </label>

            <div className="provider-tier-label">{t('settings.tierTranslationOnly')}</div>

            <label className="provider-option">
              <input
                type="radio"
                name="translation-provider"
                checked={settings.provider === 'local'}
                onChange={() => onUpdate({ provider: 'local' })}
              />
              <div className="provider-option-body">
                <div className="provider-option-title">{t('settings.providerLocal')}</div>
                <div className="provider-option-caption">{t('settings.providerLocalCaption')}</div>
              </div>
            </label>
          </div>
        </div>

        {(settings.provider === 'anthropic' || settings.provider === 'openai') && (
          <div className="settings-field">
            <label>
              {settings.provider === 'anthropic'
                ? t('settings.anthropicApiKey')
                : t('settings.openaiApiKey')}
            </label>
            <input
              type="password"
              placeholder={settings.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
              value={settings.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
            <p className="settings-hint">{t('settings.apiKeyHint')}</p>
          </div>
        )}

        {settings.provider === 'ollama' && (
          <>
            <div className="settings-field">
              <label>{t('settings.ollamaBaseUrl')}</label>
              <input
                type="url"
                placeholder="http://localhost:11434"
                value={settings.ollamaBaseUrl}
                onChange={(e) => onUpdate({ ollamaBaseUrl: e.target.value })}
              />
              <p className="settings-hint">{t('settings.ollamaBaseUrlHint')}</p>
            </div>
            <div className="settings-field">
              <label>{t('settings.ollamaModel')}</label>
              <input
                type="text"
                placeholder="llama3.1:8b"
                value={settings.ollamaModel}
                onChange={(e) => onUpdate({ ollamaModel: e.target.value })}
              />
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
              // Update local message-translation setting
              onUpdate({ preferredLanguage: lang });
              // Persist to actor profile so the UI also re-localizes
              api
                .updateProfile({ preferredLanguage: lang })
                .then((updated) => onActorUpdate?.(updated))
                .catch(() => {
                  /* non-fatal — message translation still works */
                });
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
