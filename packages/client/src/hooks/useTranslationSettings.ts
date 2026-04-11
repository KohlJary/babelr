// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback } from 'react';
import type { TranslationSettings } from '../translation';

const STORAGE_KEY = 'babelr:translation-settings';

const DEFAULTS: TranslationSettings = {
  anthropicApiKey: '',
  openaiApiKey: '',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: '',
  preferredLanguage: 'en',
  enabled: true,
  provider: 'local',
};

/**
 * Older settings stored a single `apiKey` field shared between
 * Anthropic and OpenAI. That's confusing — switching providers
 * would silently wipe the key for the other one. New shape has
 * per-provider fields; we migrate the legacy value into the slot
 * that matches whatever provider was active when the user last
 * saved, so nobody has to re-paste their key after upgrading.
 */
interface LegacySettings extends Partial<TranslationSettings> {
  apiKey?: string;
}

function loadSettings(): TranslationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as LegacySettings;

      // Migrate: add provider field if missing (pre-M6 settings)
      if (!parsed.provider) {
        parsed.provider = parsed.apiKey ? 'anthropic' : 'local';
      }

      // Migrate legacy unified `apiKey` into the per-provider slot.
      // Only routes to openai if openai was the active provider at
      // save time — otherwise defaults to the Anthropic slot, since
      // Anthropic was the only cloud option before this split.
      if (parsed.apiKey && !parsed.anthropicApiKey && !parsed.openaiApiKey) {
        if (parsed.provider === 'openai') {
          parsed.openaiApiKey = parsed.apiKey;
        } else {
          parsed.anthropicApiKey = parsed.apiKey;
        }
      }
      delete parsed.apiKey;

      // Merge over defaults so newly-added fields get sensible
      // values on pre-existing installs.
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return { ...DEFAULTS };
}

export function useTranslationSettings() {
  const [settings, setSettings] = useState<TranslationSettings>(loadSettings);

  const updateSettings = useCallback((partial: Partial<TranslationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
