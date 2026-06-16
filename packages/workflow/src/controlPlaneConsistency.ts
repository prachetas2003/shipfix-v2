import { databaseFingerprint, logDatabaseFingerprint, type ShipfixEnvLoadResult } from "@shipfix/db";

export const CONTROL_PLANE_CONSISTENCY_EVENT = "internal_control_plane_consistency_error";

export class ControlPlaneConsistencyError extends Error {
  readonly code = CONTROL_PLANE_CONSISTENCY_EVENT;
  readonly runId: string;

  constructor(runId: string, detail: string) {
    super(`Run ${runId} not found in worker database. ${detail}`);
    this.name = "ControlPlaneConsistencyError";
    this.runId = runId;
  }
}

export function controlPlaneConsistencyDetail(runId: string): string {
  const fp = databaseFingerprint(process.env.DATABASE_URL);
  return (
    `Worker DB fingerprint hostHash=${fp.hostHash ?? "none"}, database=${fp.databaseName ?? "unknown"}. ` +
    `This usually means the API and worker are connected to different databases. ` +
    `After changing DATABASE_URL, restart API, worker, web, and Temporal; old Temporal workflows may reference runs in a previous database.`
  );
}

export function isControlPlaneConsistencyMessage(message: string): boolean {
  return (
    /Run [0-9a-f-]{36} not found/i.test(message) ||
    message.includes(CONTROL_PLANE_CONSISTENCY_EVENT) ||
    message.includes("ControlPlaneConsistencyError")
  );
}

export function logWorkerControlPlaneMismatch(
  runId: string,
  message: string,
  envLoad?: ShipfixEnvLoadResult,
): void {
  const fp = databaseFingerprint(process.env.DATABASE_URL);
  // eslint-disable-next-line no-console
  console.error(`[shipfix-worker] ${CONTROL_PLANE_CONSISTENCY_EVENT}`, {
    runId,
    message,
    dbFingerprint: fp,
    envSourcePath: envLoad?.envSourcePath,
  });
  if (envLoad) {
    logDatabaseFingerprint("shipfix-worker", process.env.DATABASE_URL, envLoad);
  }
}
