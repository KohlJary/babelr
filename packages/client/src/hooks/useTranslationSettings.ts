// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback } from 'react';
import type { TranslationSettings } from '../translation';

const STORAGE_KEY = 'babelr:translation-settings';

function loadSettings(): TranslationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // Ignore parse errors
  }
  return { apiKey: '', preferredLanguage: 'en', enabled: true };
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
