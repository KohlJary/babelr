// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState, useRef } from 'react';

/**
 * Shape of a single model entry in Ollama's `/api/tags` response.
 * We only care about the name — size/digest/modified_at are useful
 * metadata but don't affect picker behavior.
 */
interface OllamaModelEntry {
  name: string;
}

export type OllamaDiscoveryStatus = 'idle' | 'checking' | 'ok' | 'empty' | 'error';

export interface OllamaDiscoveryResult {
  status: OllamaDiscoveryStatus;
  models: string[];
  /** Only populated when status === 'error'. Short human-readable reason. */
  error?: string;
}

const DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Given the user's configured Ollama base URL, discover which models
 * are available on that instance. Debounces changes so we don't fire
 * a network request on every keystroke, and aborts any in-flight
 * request when the URL changes again before it resolves.
 *
 * Returns a status-based result shape the settings panel can branch
 * on to render a dropdown (when status === 'ok'), a message
 * (checking / empty / error), or fall back to the text input (idle).
 *
 * Note: this calls Ollama directly from the browser, same as the
 * translation provider itself. CORS applies — the user's Ollama
 * needs to be started with `OLLAMA_ORIGINS='*'` (or a more
 * restrictive allow-list) to respond to browser requests.
 */
export function useOllamaModels(baseUrl: string): OllamaDiscoveryResult {
  const [result, setResult] = useState<OllamaDiscoveryResult>({
    status: 'idle',
    models: [],
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      setResult({ status: 'idle', models: [] });
      return;
    }

    // Abort any still-pending request from a previous URL value.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResult({ status: 'checking', models: [] });

    const timer = setTimeout(async () => {
      // Normalize the URL the same way OllamaProvider does, so a user
      // who pastes `http://localhost:11434/api/` or a trailing slash
      // still gets a working discovery.
      const base = trimmed.replace(/\/+$/, '').replace(/\/api$/, '');
      const url = `${base}/api/tags`;

      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (controller.signal.aborted) return;

        if (!res.ok) {
          setResult({
            status: 'error',
            models: [],
            error: `Ollama responded with ${res.status}`,
          });
          return;
        }

        const data = (await res.json()) as { models?: OllamaModelEntry[] };
        const models = (data.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
          .sort();

        if (models.length === 0) {
          setResult({ status: 'empty', models: [] });
        } else {
          setResult({ status: 'ok', models });
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Request failed';
        setResult({ status: 'error', models: [], error: msg });
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl]);

  return result;
}
