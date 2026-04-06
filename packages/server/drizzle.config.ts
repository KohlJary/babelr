// SPDX-License-Identifier: Hippocratic-3.0
import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// Load .env from project root if DATABASE_URL not already set
if (!process.env.DATABASE_URL) {
  try {
    const envFile = readFileSync('../../.env', 'utf-8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // .env not found, rely on environment
  }
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
