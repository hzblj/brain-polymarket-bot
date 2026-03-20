import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import * as relations from './relations';

export type DbClient = ReturnType<typeof createDb>;

export function createDb(connectionString: string, options?: { maxConnections?: number; ssl?: boolean }) {
  const client = postgres(connectionString, {
    max: options?.maxConnections ?? 10,
    ssl: options?.ssl ? 'require' : undefined,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, {
    schema: { ...schema, ...relations },
  });
}
