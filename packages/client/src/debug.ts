// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Channel-based diagnostic logger.
 *
 * Diagnostic logs throughout the client are tagged with a channel name
 * (e.g. "voice", "ws", "i18n"). A channel is ONLY logged when it's been
 * enabled via localStorage, so by default the console stays quiet in
 * production but any user reporting a bug can opt into verbose logging
 * for the relevant subsystem with a single devtools command.
 *
 * Enable channels from devtools:
 *   babelrDebug.enable('voice')
 *   babelrDebug.enable('voice', 'ws')
 *   babelrDebug.enable('*')          // enable everything
 *   babelrDebug.disable('voice')
 *   babelrDebug.list()               // current active channels
 *
 * Or set the localStorage key directly:
 *   localStorage.setItem('babelr:debug', 'voice,ws')
 *
 * See .daedalus/diagnostics.md for the authoritative list of channels
 * and the call sites that log on each one.
 */

const STORAGE_KEY = 'babelr:debug';

const channels = new Set<string>();

function loadChannels(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const ch of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      channels.add(ch);
    }
  } catch {
    /* localStorage unavailable (SSR, private mode, etc) — quietly no-op */
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, Array.from(channels).join(','));
  } catch {
    /* ignore */
  }
}

function enabled(channel: string): boolean {
  return channels.has('*') || channels.has(channel);
}

/** Log if the channel is enabled. Drops the call entirely otherwise. */
export function debug(channel: string, ...args: unknown[]): void {
  if (enabled(channel)) {
    console.log(`[${channel}]`, ...args);
  }
}

export function debugWarn(channel: string, ...args: unknown[]): void {
  if (enabled(channel)) {
    console.warn(`[${channel}]`, ...args);
  }
}

export function debugError(channel: string, ...args: unknown[]): void {
  if (enabled(channel)) {
    console.error(`[${channel}]`, ...args);
  }
}

/** Imperative getter for expensive diagnostic work that should only run when enabled. */
export function debugEnabled(channel: string): boolean {
  return enabled(channel);
}

export function debugEnable(...names: string[]): void {
  for (const name of names) channels.add(name);
  persist();
  console.info(
    `[babelrDebug] enabled: ${Array.from(channels).join(', ') || '(none)'}`,
  );
}

export function debugDisable(...names: string[]): void {
  for (const name of names) channels.delete(name);
  persist();
  console.info(
    `[babelrDebug] enabled: ${Array.from(channels).join(', ') || '(none)'}`,
  );
}

export function debugList(): string[] {
  return Array.from(channels);
}

// Initialize from localStorage on module load
loadChannels();

// Expose the toggle API on window for easy devtools access.
// Typed loosely to keep the global clean.
if (typeof window !== 'undefined') {
  (window as unknown as { babelrDebug: unknown }).babelrDebug = {
    enable: debugEnable,
    disable: debugDisable,
    list: debugList,
  };
}
