// SPDX-License-Identifier: Hippocratic-3.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/server/src/__tests__/**/*.test.ts'],
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
  },
});
