import { createSafePostgresSink, createRunLogger } from "@shipfix/observability";
import { createDb, deployedResources, runs, type Database } from "@shipfix/db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";

const NON_TERMINAL_STATUSES = [
  "queued",
  "cloning",
  "analyzing",
  "planning",
  "validating",
  "awaiting_input",
  "provisioning",
  "deploying",
  "verifying",
] as const;

export interface ReconcileStuckRunsOptions {
  /** Mark runs stuck longer than this (default 20 minutes). */
  olderThanMs?: number;
  /** When true, report actions without writing. */
  dryRun?: boolean;
}

export interface ReconcileStuckRunResult {
  runId: string;
  previousStatus: string;
  newStatus: "diagnosed" | "failed";
  reason: string;
  liveResources: number;
}

export interface ReconcileStuckRunsSummary {
  examined: number;
  reconciled: number;
  results: ReconcileStuckRunResult[];
}

/**
 * Mark abandoned non-terminal runs so the UI does not show "deploying" forever
 * after a worker crash or hung provider call. Does not delete provider resources
 * or rows in deployed_resources.
 */
export async function reconcileStuckRuns(
  db: Database,
  opts: ReconcileStuckRunsOptions = {},
): Promise<ReconcileStuckRunsSummary> {
  const olderThanMs = opts.olderThanMs ?? 20 * 60 * 1000;
  const cutoff = new Date(Date.now() - olderThanMs);

  const stuck = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...NON_TERMINAL_STATUSES]),
        isNull(runs.finishedAt),
        lt(runs.startedAt, cutoff),
      ),
    );

  const results: ReconcileStuckRunResult[] = [];

  for (const row of stuck) {
    const resources = await db
      .select({ status: deployedResources.status })
      .from(deployedResources)
      .where(eq(deployedResources.runId, row.id));
    const liveCount = resources.filter((r) => r.status === "live").length;
    const hasLive = liveCount > 0;
    const newStatus = hasLive ? ("diagnosed" as const) : ("failed" as const);
    const reason = hasLive
      ? "Run was stuck in a non-terminal state (worker interrupted or deploy timed out). Backend/database resources already recorded remain live; rerun Deploy to retry the frontend."
      : "Run was stuck with no live resources (worker interrupted or deploy never completed).";

    results.push({
      runId: row.id,
      previousStatus: row.status,
      newStatus,
      reason,
      liveResources: liveCount,
    });

    if (opts.dryRun) continue;

    await db
      .update(runs)
      .set({ status: newStatus, finishedAt: new Date() })
      .where(eq(runs.id, row.id));

    const logger = createRunLogger(row.id, createSafePostgresSink(db));
    await logger.warn(reason, {
      event: "run_reconciled",
      previousStatus: row.status,
      newStatus,
      liveResources: liveCount,
    });
    await logger.stage(newStatus, reason);
  }

  return {
    examined: stuck.length,
    reconciled: opts.dryRun ? 0 : results.length,
    results,
  };
}

/** CLI entry: `node reconcile-stuck-runs.mjs` with DATABASE_URL set. */
export async function reconcileStuckRunsFromEnv(
  opts: ReconcileStuckRunsOptions = {},
): Promise<ReconcileStuckRunsSummary> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const db = createDb(url);
  return reconcileStuckRuns(db, opts);
}
