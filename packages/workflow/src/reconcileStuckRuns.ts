import { createSafePostgresSink, createRunLogger } from "@shipfix/observability";
import { createDb, deployedResources, runEvents, runs, type Database } from "@shipfix/db";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

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
  /** Mark queued runs as stuck faster because no worker progress has happened. */
  queuedOlderThanMs?: number;
  /** Mark analysis -> planning handoff stalls faster than generic stuck runs. */
  planTransitionOlderThanMs?: number;
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
  const queuedOlderThanMs = opts.queuedOlderThanMs ?? 45 * 1000;
  const planTransitionOlderThanMs = opts.planTransitionOlderThanMs ?? 60 * 1000;
  const cutoff = new Date(Date.now() - olderThanMs);
  const queuedCutoff = new Date(Date.now() - queuedOlderThanMs);
  const planTransitionCutoff = new Date(Date.now() - planTransitionOlderThanMs);

  const stuck = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...NON_TERMINAL_STATUSES]),
        isNull(runs.finishedAt),
        or(
          lt(runs.startedAt, cutoff),
          and(eq(runs.status, "queued"), lt(runs.startedAt, queuedCutoff)),
          and(inArray(runs.status, ["analyzing", "planning"]), lt(runs.startedAt, planTransitionCutoff)),
        ),
      ),
    );

  const results: ReconcileStuckRunResult[] = [];

  for (const row of stuck) {
    const events = await db
      .select({ stage: runEvents.stage, data: runEvents.data })
      .from(runEvents)
      .where(eq(runEvents.runId, row.id));
    const resources = await db
      .select({ status: deployedResources.status })
      .from(deployedResources)
      .where(eq(deployedResources.runId, row.id));
    const liveCount = resources.filter((r) => r.status === "live").length;
    const hasLive = liveCount > 0;
    let newStatus = hasLive ? ("diagnosed" as const) : ("failed" as const);
    const validationStalled = row.status === "validating";
    const queuedStalled = row.status === "queued";
    const eventNames = events.map((e) => (e.data as { event?: unknown } | null)?.event).filter(Boolean);
    const hasEvent = (names: string[]) => eventNames.some((eventName) => names.includes(String(eventName)));
    const workflowStarted = hasEvent(["workflow_started"]);
    const workerProgress = events.some((e) => e.stage && e.stage !== "queued");
    const analysisCompleted = hasEvent(["analysis_completed"]);
    const planningStarted = hasEvent([
      "planning_started",
      "plan_generation_started",
      "plan_reused",
      "plan_generated",
      "plan_validated",
    ]);
    const planGenerationDone = hasEvent([
      "plan_generation_completed",
      "plan_reused",
      "plan_generated",
      "plan_validated",
      "llm_unavailable",
      "llm_config_missing",
      "llm_rate_limited",
      "planning_failed",
      "internal_plan_transition_failed",
      "internal_plan_generation_failed",
      "internal_plan_generation_stalled",
      "internal_control_plane_consistency_error",
    ]);
    const planningTransitionStalled = analysisCompleted && !planningStarted && !planGenerationDone;
    const planningGenerationStalled = row.status === "planning" && planningStarted && !planGenerationDone;
    const eventName = queuedStalled
      ? workflowStarted && !workerProgress
        ? "internal_worker_not_polling"
        : "internal_workflow_start_missing"
      : planningTransitionStalled
        ? "internal_plan_transition_failed"
        : planningGenerationStalled
          ? "internal_plan_generation_stalled"
      : validationStalled
        ? "internal_validation_stalled"
        : "run_reconciled";
    if (eventName === "internal_worker_not_polling") newStatus = "diagnosed";
    const reason =
      eventName === "internal_workflow_start_missing"
        ? "ShipFix queued the run, but no Temporal workflow start was recorded. Start Temporal and retry."
        : eventName === "internal_worker_not_polling"
          ? "ShipFix queued the run and started the workflow, but the worker did not pick it up. Start the worker or check Temporal/task queue configuration."
          : eventName === "internal_plan_transition_failed"
            ? "ShipFix analyzed the repository, but the workflow did not enter plan generation. Restart API and worker, then retry; this is a ShipFix control-plane issue, not a repo issue."
            : eventName === "internal_plan_generation_stalled"
              ? "ShipFix started plan generation, but no plan or planner error was recorded. Restart API and worker, then retry; this is a ShipFix planning-stage issue."
          : validationStalled
            ? "Plan validation stalled inside ShipFix. The run was finalized so it does not stay validating forever; start a new plan/deploy after restarting API and worker."
            : hasLive
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
      event: eventName,
      previousStatus: row.status,
      newStatus,
      liveResources: liveCount,
      workflowStarted,
      workerProgress,
      analysisCompleted,
      planningStarted,
      planGenerationDone,
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
