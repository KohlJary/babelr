// SPDX-License-Identifier: MIT

/**
 * Whether someone is signed in, for code that runs outside React (the
 * plugin loader runs at page load, before /auth/me has answered). App
 * sets it from useAuth; plugins read it through PluginClientApi.session.
 */
let signedIn = false;
const listeners = new Set<(signedIn: boolean) => void>();

export function setSignedIn(value: boolean): void {
  if (value === signedIn) return;
  signedIn = value;
  for (const l of [...listeners]) l(value);
}

export function isSignedIn(): boolean {
  return signedIn;
}

export function onSessionChange(listener: (signedIn: boolean) => void): () => void {
  listeners.add(listener);
  listener(signedIn);
  return () => {
    listeners.delete(listener);
  };
}

/** Plugins call this (via availabilityChanged) when an isAvailable answer
 *  flips; ChatView listens and re-renders its view list. */
export const VIEWS_CHANGED_EVENT = 'babelr:views-changed';

export function notifyViewsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VIEWS_CHANGED_EVENT));
}
