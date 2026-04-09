// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { TranslationSettings } from '../translation';
import * as api from '../api';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
  { code: 'vi', label: 'Vietnamese' },
];

interface SettingsPanelProps {
  settings: TranslationSettings;
  onUpdate: (partial: Partial<TranslationSettings>) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onUpdate, onClose }: SettingsPanelProps) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwStatus, setPwStatus] = useState<string | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPw || !newPw) return;
    if (newPw.length < 12) {
      setPwStatus('New password must be at least 12 characters');
      return;
    }
    setPwSubmitting(true);
    setPwStatus(null);
    try {
      await api.changePassword(currentPw, newPw);
      setPwStatus('Password changed successfully');
      setCurrentPw('');
      setNewPw('');
    } catch (err) {
      setPwStatus(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-field">
          <label>Translation engine</label>
          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${settings.provider === 'anthropic' ? 'active' : ''}`}
              onClick={() => onUpdate({ provider: 'anthropic' })}
            >
              Cloud (Claude)
            </button>
            <button
              type="button"
              className={`auth-tab ${settings.provider === 'local' ? 'active' : ''}`}
              onClick={() => onUpdate({ provider: 'local' })}
            >
              Local (Browser)
            </button>
          </div>
        </div>

        {settings.provider === 'anthropic' && (
          <div className="settings-field">
            <label>Anthropic API Key</label>
            <input
              type="password"
              placeholder="sk-ant-..."
              value={settings.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
            <p className="settings-hint">
              Your key is stored locally in your browser. It is never saved on the server.
            </p>
          </div>
        )}

        {settings.provider === 'local' && (
          <div className="settings-field">
            <p className="settings-hint">
              Translations run entirely in your browser. First use downloads a ~50MB model per
              language pair. Tone, intent, and idiom annotations are not available with local
              translation.
            </p>
          </div>
        )}

        <div className="settings-field">
          <label>Read messages in</label>
          <select
            value={settings.preferredLanguage}
            onChange={(e) => onUpdate({ preferredLanguage: e.target.value })}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
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
            <span>Enable translation</span>
          </label>
        </div>

        <div className="settings-divider" />

        <form className="settings-field" onSubmit={handlePasswordChange} style={{ gap: '0.5rem' }}>
          <label>Change password</label>
          <input
            type="password"
            placeholder="Current password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            className="modal-input"
          />
          <input
            type="password"
            placeholder="New password (min 12 chars)"
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
            {pwSubmitting ? '...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
