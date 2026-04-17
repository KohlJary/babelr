// SPDX-License-Identifier: Hippocratic-3.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dev proxy target and listen port are overridable via env vars so
// federation testing can spin up multiple vite instances side-by-side,
// each pointing at its own backend. In the single-instance default
// case (vanilla `npm run dev:client`) nothing changes — the defaults
// match the pre-existing config.
const devPort = Number(process.env.VITE_DEV_PORT) || 1111;
const proxyHttpTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:3000';
const proxyWsTarget = proxyHttpTarget.replace(/^http/, 'ws');

// Vite 5.1+ rejects requests whose Host header isn't on an allow list.
// The federation-testing rig loads the client from babelr-a.local and
// babelr-b.local (via /etc/hosts aliases), so those hostnames must be
// whitelisted or vite returns a 403 before the page can even render.
// Safe to hardcode — these names are reserved for local federation
// testing and never collide with real traffic.
const allowedHosts = [
  'localhost',
  '127.0.0.1',
  'babelr-a.local',
  'babelr-b.local',
];

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Babelr',
        short_name: 'Babelr',
        description: 'Federated chat with tone-preserving translation',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Only precache the app shell — Shiki splits 300+ grammar
        // chunks that shouldn't be precached. The index + main CSS +
        // HTML + fonts + images are enough for offline shell.
        globPatterns: ['**/*.{css,html,woff2,svg,png}', 'assets/index-*.js'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
    port: devPort,
    // Bind to all interfaces so the federation-testing hostname
    // aliases (babelr-a.local, babelr-b.local) can reach vite. The
    // default `localhost` binding on some Linux configs only covers
    // ::1 and not 127.0.0.1, which produces a TCP refusal for any
    // client connecting via an alias IPv4 address.
    host: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: proxyHttpTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: proxyWsTarget,
        ws: true,
      },
      '/uploads': {
        target: proxyHttpTarget,
        changeOrigin: true,
      },
    },
  },
});
