// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback } from 'react';
import type { TranslationSettings } from '../translation';

const STORAGE_KEY = 'babelr:translation-settings';

const DEFAULTS: TranslationSettings = {
  apiKey: '',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: '',
  preferredLanguage: 'en',
  enabled: true,
  provider: 'local',
};

function loadSettings(): TranslationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<TranslationSettings>;
      // Migrate: add provider field if missing (pre-M6 settings)
      if (!parsed.provider) {
        parsed.provider = parsed.apiKey ? 'anthropic' : 'local';
      }
      // Merge over defaults so newly-added fields (ollamaBaseUrl,
      // ollamaModel) get sensible values on pre-existing installs.
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
