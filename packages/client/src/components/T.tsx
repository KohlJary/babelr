// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo } from 'react';
import { useTranslateStrings } from '../hooks/useTranslateStrings';
import { useTranslationSettings } from '../hooks/useTranslationSettings';

interface TProps {
  children: string;
}

/**
 * `<T>{text}</T>` — auto-translating wrapper for plaintext strings.
 *
 * Reads the app's TranslationSettings, pipes the wrapped string
 * through the standard translation cache (content-hash keyed, per-
 * target-language, localStorage-persistent), and renders the
 * translated output. Plugin authors wrap user-facing strings with
 * this instead of wiring useTranslateStrings by hand — translation
 * becomes the default rather than a feature plugin authors have to
 * remember to opt into.
 *
 * The underlying cache dedupes repeated renders of the same string
 * across components, so naive per-string `<T>` usage doesn't produce
 * N translation calls for N identical strings.
 *
 * Limitations:
 *   - Accepts only plaintext (typed `children: string`). For
 *     programmatically-assembled content, call useTranslateStrings
 *     directly.
 *   - Skips empty strings and strings that are only whitespace.
 *   - Falls back to the original text on error or when no provider
 *     is configured.
 */
export function T({ children }: TProps) {
  const { settings } = useTranslationSettings();
  const strings = useMemo(() => ({ text: children }), [children]);
  const translated = useTranslateStrings(strings, settings);
  return <>{translated.text ?? children}</>;
}
