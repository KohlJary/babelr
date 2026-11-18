/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// A new build takes over on the next load instead of waiting for every tab and the
// installed app to close (registerType autoUpdate needs the worker to do this). Without
// it, an open app kept an old index.html whose script no longer existed after a rebuild,
// and plugins added since never appeared.
void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Precache the app shell (injected by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);

// Push notification handler — suppressed when any app window is focused
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json() as {
      title: string;
      body: string;
      tag?: string;
      data?: Record<string, unknown>;
    };

    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        const anyFocused = clients.some((c) => (c as WindowClient).focused);
        if (anyFocused) return;

        return self.registration.showNotification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          icon: '/pwa-192.png',
          badge: '/pwa-192.png',
          data: payload.data,
        });
      }),
    );
  } catch {
    // Malformed payload — ignore
  }
});

// Notification click → focus or open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data as { channelId?: string } | undefined;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      const url = data?.channelId ? `/?channel=${data.channelId}` : '/';
      return self.clients.openWindow(url);
    }),
  );
});
