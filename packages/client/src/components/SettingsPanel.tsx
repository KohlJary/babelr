// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationSettings } from '../translation';

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
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Translation Settings</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

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
      </div>
    </div>
  );
}
