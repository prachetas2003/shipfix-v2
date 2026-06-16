import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { runs, type Database } from "@shipfix/db";

/**
 * Ensure the run row is readable from the same DB connection before starting a
 * Temporal workflow. Prevents racing workflow pickup ahead of commit visibility.
 */
export async function assertRunPersisted(db: Database, runId: string): Promise<void> {
  const [row] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!row) {
    throw new Error(`Run ${runId} was not readable immediately after insert.`);
  }
}

/** @internal test helper — same path resolution as API env bootstrap. */
export function apiEnvPaths(importMetaUrl: string): { rootEnvPath: string; appLocalEnvPath: string } {
  return {
    rootEnvPath: fileURLToPath(new URL("../../../.env", importMetaUrl)),
    appLocalEnvPath: fileURLToPath(new URL("../.env.local", importMetaUrl)),
  };
}

/** @internal test helper — same path resolution as worker env bootstrap. */
export function workerEnvPaths(importMetaUrl: string): { rootEnvPath: string; appLocalEnvPath: string } {
  return apiEnvPaths(importMetaUrl);
}

export async function startWorkflowAfterPersistedRun(
  db: Database,
  runId: string,
  start: () => Promise<void>,
): Promise<void> {
  await assertRunPersisted(db, runId);
  await start();
}
