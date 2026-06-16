import { eq } from "drizzle-orm";
import { runs, type Database } from "@shipfix/db";
import type { RunLogger } from "@shipfix/observability";

export interface WorkflowStartInfo {
  workflowId: string;
  taskQueue: string;
  temporalAddress: string;
  temporalNamespace: string;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function logWorkflowStarting(
  logger: RunLogger,
  info: WorkflowStartInfo,
): Promise<void> {
  await logger.log("Starting Temporal workflow", {
    event: "workflow_starting",
    workflowId: info.workflowId,
    taskQueue: info.taskQueue,
    temporalAddress: info.temporalAddress,
    temporalNamespace: info.temporalNamespace,
  });
}

export async function logWorkflowStarted(
  logger: RunLogger,
  info: WorkflowStartInfo,
): Promise<void> {
  await logger.log("Temporal workflow started", {
    event: "workflow_started",
    workflowId: info.workflowId,
    taskQueue: info.taskQueue,
    temporalAddress: info.temporalAddress,
    temporalNamespace: info.temporalNamespace,
  });
}

export async function markWorkflowStartFailed(
  db: Database,
  logger: RunLogger,
  runId: string,
  info: WorkflowStartInfo,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(runs)
    .set({ status: "failed", finishedAt: new Date() })
    .where(eq(runs.id, runId));
  await logger.error(
    "ShipFix could not start the deployment workflow. Check Temporal and worker configuration.",
    {
      event: "internal_workflow_start_failed",
      workflowId: info.workflowId,
      taskQueue: info.taskQueue,
      temporalAddress: info.temporalAddress,
      temporalNamespace: info.temporalNamespace,
      message,
    },
  );
}
