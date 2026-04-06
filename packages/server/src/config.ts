// SPDX-License-Identifier: Hippocratic-3.0

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  domain: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl,
    domain: process.env.BABELR_DOMAIN ?? 'localhost:3000',
    sessionSecret,
    secureCookies: process.env.NODE_ENV === 'production',
  };
}
