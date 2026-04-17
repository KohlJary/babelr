// SPDX-License-Identifier: Hippocratic-3.0

const API_BASE = '/api';

/** Whether we have desktop notification permission (even without
 *  a service worker — used for dev-mode fallback). */
let desktopNotifGranted = false;

/**
 * Request notification permission and subscribe to web push.
 * Called once after login (or from settings). No-op if push
 * isn't supported or the user denies permission.
 *
 * In dev mode (no service worker), still requests permission so
 * showDesktopNotification() works as a fallback.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!('Notification' in window)) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  desktopNotifGranted = true;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }

  // Get the VAPID public key from the server
  const res = await fetch(`${API_BASE}/push/vapid-key`, {
    credentials: 'include',
  });
  if (!res.ok) return false;
  const { enabled, key } = await res.json();
  if (!enabled || !key) return false;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // Already subscribed — re-register with the server in case the
    // actor changed (different user on the same browser).
    await registerSubscription(existing);
    return true;
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
  });

  await registerSubscription(subscription);
  return true;
}

async function registerSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await fetch(`${API_BASE}/push/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      },
    }),
  });
}

/**
 * Show a desktop notification via the Notification API. Works in both
 * dev mode (no SW) and production (SW handles push separately). Call
 * this from the WS message handler for new messages from other users
 * when the tab is not focused.
 */
export function showDesktopNotification(
  title: string,
  body: string,
  tag?: string,
): void {
  if (!desktopNotifGranted || document.hasFocus()) return;
  try {
    new Notification(title, {
      body,
      tag,
      icon: '/pwa-192.png',
    });
  } catch {
    // Notification constructor can throw in some contexts
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
