import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema";

export * from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/**
 * Create a typed Drizzle client.
 *
 * TODO: add pooling config, read replicas, and graceful shutdown as the control
 * plane grows. Migrations are managed via drizzle-kit (`pnpm --filter @shipfix/db db:generate`).
 */
export function createDb(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}
