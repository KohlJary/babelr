// SPDX-License-Identifier: Hippocratic-3.0
import { createContext, useContext, useEffect, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { UI_STRINGS } from '@babelr/shared';
import type { UIStringKey } from '@babelr/shared';

interface I18nContextValue {
  lang: string;
  dict: Record<string, string>;
  loading: boolean;
  t: (key: UIStringKey) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  dict: UI_STRINGS as Record<string, string>,
  loading: false,
  t: (key: UIStringKey) => UI_STRINGS[key],
});

interface I18nProviderProps {
  lang: string;
  children: ReactNode;
}

export function I18nProvider({ lang, children }: I18nProviderProps) {
  const [dict, setDict] = useState<Record<string, string>>(UI_STRINGS as Record<string, string>);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!lang || lang === 'en') {
      setDict(UI_STRINGS as Record<string, string>);
      return;
    }
    setLoading(true);
    fetch(`/api/i18n/${encodeURIComponent(lang)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data === 'object') {
          // Merge with English defaults so any missing key still resolves
          setDict({ ...(UI_STRINGS as Record<string, string>), ...data });
        }
      })
      .catch(() => {
        // Fall back to English on any error
        setDict(UI_STRINGS as Record<string, string>);
      })
      .finally(() => setLoading(false));
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => {
    return {
      lang,
      dict,
      loading,
      t: (key: UIStringKey) => dict[key] ?? UI_STRINGS[key] ?? key,
    };
  }, [lang, dict, loading]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useUITranslation() {
  return useContext(I18nContext);
}

/** Convenience: returns just the t() function. */
export function useT() {
  return useContext(I18nContext).t;
}
