// SPDX-License-Identifier: Hippocratic-3.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy target and listen port are overridable via env vars so
// federation testing can spin up multiple vite instances side-by-side,
// each pointing at its own backend. In the single-instance default
// case (vanilla `npm run dev:client`) nothing changes — the defaults
// match the pre-existing config.
const devPort = Number(process.env.VITE_DEV_PORT) || 1111;
const proxyHttpTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:3000';
const proxyWsTarget = proxyHttpTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
    port: devPort,
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
