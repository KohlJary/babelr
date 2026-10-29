// SPDX-License-Identifier: MIT
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: parseInt(process.env.DB_POOL_SIZE ?? '20', 10),
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
