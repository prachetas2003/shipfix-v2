import { databaseFingerprint, type ShipfixEnvLoadResult } from "@shipfix/db";
import type { Env } from "./env";

export interface WorkerHeartbeatRow {
  lastSeenAt: Date | string;
  taskQueue: string;
  temporalAddress: string;
  temporalNamespace: string;
  status: string;
}

export function workerHeartbeatDiagnostics(
  row: WorkerHeartbeatRow | null,
  now = new Date(),
  recentMs = 60_000,
) {
  const lastSeenAt = row ? new Date(row.lastSeenAt) : null;
  const ageMs = lastSeenAt ? now.getTime() - lastSeenAt.getTime() : null;
  return {
    workerRecentlySeen: ageMs !== null && ageMs >= 0 && ageMs <= recentMs,
    lastWorkerHeartbeatAt: lastSeenAt?.toISOString() ?? null,
    workerHeartbeatAgeMs: ageMs,
    workerTaskQueue: row?.taskQueue ?? null,
    workerTemporalAddress: row?.temporalAddress ?? null,
    workerTemporalNamespace: row?.temporalNamespace ?? null,
    workerStatus: row?.status ?? null,
  };
}

/** Safe control-plane diagnostics for `/admin/config-check` (no secrets). */
export function apiControlPlaneDiagnostics(
  env: Env,
  shipfixEnvLoad: ShipfixEnvLoadResult,
  workerHeartbeat?: WorkerHeartbeatRow | null,
  temporalStatus?: { reachable: boolean; checkedAt: string | null; error: string | null } | null,
) {
  const apiDbFingerprint = databaseFingerprint(env.DATABASE_URL);
  return {
    databaseUrlPresent: apiDbFingerprint.databaseUrlPresent,
    apiDbFingerprint: {
      ...apiDbFingerprint,
      envSourcePath: shipfixEnvLoad.envSourcePath,
      rootEnvOverride: shipfixEnvLoad.rootEnvOverride,
      appLocalEnvOverride: shipfixEnvLoad.appLocalEnvOverride,
    },
    temporalAddress: env.TEMPORAL_ADDRESS,
    temporalTaskQueue: env.TEMPORAL_TASK_QUEUE,
    temporalNamespace: env.TEMPORAL_NAMESPACE,
    temporalReachable: temporalStatus?.reachable ?? null,
    temporalLastCheckedAt: temporalStatus?.checkedAt ?? null,
    temporalError: temporalStatus?.error ?? null,
    ...workerHeartbeatDiagnostics(workerHeartbeat ?? null),
  };
}
