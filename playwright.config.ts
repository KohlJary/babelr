// SPDX-License-Identifier: Hippocratic-3.0
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:1111',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev:client',
    url: 'http://localhost:1111',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
