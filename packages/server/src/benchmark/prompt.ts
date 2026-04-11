// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Historical location of the translation prompt helpers. The
 * canonical copy now lives in `@babelr/shared/translation-prompt`
 * so client-side providers (Ollama) can reuse it without going
 * through the server. This module is kept as a thin re-export so
 * the benchmark runner and any older imports keep working.
 */
export { buildPrompt, parseResponse } from '@babelr/shared';
