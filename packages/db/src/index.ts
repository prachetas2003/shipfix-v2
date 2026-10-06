import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { githubInstallations, schema } from "./schema";

export * from "./schema";
export {
  loadShipfixEnv,
  databaseFingerprint,
  effectiveTemporalTaskQueue,
  logDatabaseFingerprint,
  type ShipfixEnvLoadOptions,
  type ShipfixEnvLoadResult,
  type DatabaseFingerprint,
} from "./env";

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

/** GitHub App installation ids this user has proven they control. */
export async function ownedGithubInstallationIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId));
  return rows.map((r) => r.installationId);
}
