import { fileURLToPath } from "node:url";
import {
  createDb,
  effectiveTemporalTaskQueue,
  loadShipfixEnv,
  logDatabaseFingerprint,
  workerHeartbeats,
} from "@shipfix/db";
import { NativeConnection, Worker } from "@temporalio/worker";
import { assertProductionEnv } from "@shipfix/workflow/productionEnv";
import { activities, TASK_QUEUE, workflowsPath } from "@shipfix/workflow";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const appLocalEnvPath = fileURLToPath(new URL("../.env.local", import.meta.url));
export const shipfixEnvLoad = loadShipfixEnv({
  rootEnvPath,
  appLocalEnvPath,
  rootOverride: process.env.NODE_ENV !== "production",
});
const HEARTBEAT_INTERVAL_MS = 15_000;
const workerId = `worker-${process.pid}`;
const effectiveTaskQueue = effectiveTemporalTaskQueue(
  process.env.TEMPORAL_TASK_QUEUE ?? TASK_QUEUE,
  process.env.DATABASE_URL,
  process.env.NODE_ENV,
);
assertProductionEnv("worker", process.env);

function providerKeyEnv(provider: string | undefined): string | null {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "openai") return "OPENAI_API_KEY";
  if (normalized === "anthropic") return "ANTHROPIC_API_KEY";
  if (normalized === "gemini") return "GEMINI_API_KEY";
  return null;
}

function logSafeEnvDiagnostic(): void {
  logDatabaseFingerprint("shipfix-worker", process.env.DATABASE_URL, shipfixEnvLoad);

  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const expectedKey = providerKeyEnv(provider);
  const acceptedProvider = provider === "openai" || provider === "anthropic" || provider === "gemini";
  const legacyFallbackPresent = Boolean(process.env.LLM_API_KEY?.trim());
  // eslint-disable-next-line no-console
  console.log("[shipfix-worker] env diagnostic", {
    cwd: process.cwd(),
    rootEnvPath,
    rootEnvExists: shipfixEnvLoad.rootEnvExists,
    rootEnvLoaded: shipfixEnvLoad.rootEnvLoaded,
    rootEnvOverride: shipfixEnvLoad.rootEnvOverride,
    workerEnvPath: appLocalEnvPath,
    workerEnvExists: shipfixEnvLoad.appLocalEnvExists,
    workerEnvLoaded: shipfixEnvLoad.appLocalEnvLoaded,
    workerEnvOverride: shipfixEnvLoad.appLocalEnvOverride,
    envSourcePath: shipfixEnvLoad.envSourcePath,
    LLM_PROVIDER_present: Boolean(process.env.LLM_PROVIDER?.trim()),
    LLM_PROVIDER_accepted: acceptedProvider,
    LLM_MODEL_present: Boolean(process.env.LLM_MODEL?.trim()),
    GEMINI_API_KEY_present: Boolean(process.env.GEMINI_API_KEY?.trim()),
    OPENAI_API_KEY_present: Boolean(process.env.OPENAI_API_KEY?.trim()),
    ANTHROPIC_API_KEY_present: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    NEON_ORG_ID_present: Boolean(process.env.NEON_ORG_ID?.trim()),
    NEON_ORGANIZATION_ID_present: Boolean(process.env.NEON_ORGANIZATION_ID?.trim()),
    NEON_API_KEY_present: Boolean(process.env.NEON_API_KEY?.trim()),
    LLM_API_KEY_legacy_present: legacyFallbackPresent,
    expected_provider_key_present: expectedKey ? Boolean(process.env[expectedKey]?.trim()) : false,
    provider_key_or_legacy_present: expectedKey ? Boolean(process.env[expectedKey]?.trim()) || legacyFallbackPresent : false,
    TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS || "localhost:7233",
    TEMPORAL_TASK_QUEUE: effectiveTaskQueue,
  });
  if (legacyFallbackPresent && expectedKey && !process.env[expectedKey]?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(`[shipfix-worker] using deprecated LLM_API_KEY fallback; prefer ${expectedKey} for ${provider}.`);
  }
}

/**
 * Temporal worker host — runs the deployment workflow + activities.
 *
 * Prerequisite: a running Temporal server. For local dev:
 *   temporal server start-dev
 */

async function run(): Promise<void> {
  logSafeEnvDiagnostic();
  const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE || "default";
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shipfix-worker] DATABASE_URL is not set — activities will fail. " +
        "Set it in repo-root .env or apps/worker/.env.local, then restart API and worker together.",
    );
  }
  if (!process.env.LLM_PROVIDER?.trim() || !process.env.LLM_MODEL?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shipfix-worker] LLM_PROVIDER or LLM_MODEL is not set - plan runs will fail. " +
        "Set LLM_PROVIDER, LLM_MODEL, and the provider API key in the repo-root .env or apps/worker/.env.local.",
    );
  }

  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    workflowsPath,
    activities,
    taskQueue: effectiveTaskQueue,
    namespace,
  });

  const stopHeartbeat = startHeartbeat({
    address,
    namespace,
    taskQueue: effectiveTaskQueue,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[shipfix-worker] connected to Temporal at ${address}; polling task queue "${effectiveTaskQueue}"`,
  );
  try {
    await worker.run();
  } finally {
    stopHeartbeat();
  }
}

function startHeartbeat(args: { address: string; namespace: string; taskQueue: string }): () => void {
  if (!process.env.DATABASE_URL) return () => {};
  const db = createDb(process.env.DATABASE_URL);
  const beat = async (): Promise<void> => {
    try {
      await db
        .insert(workerHeartbeats)
        .values({
          id: workerId,
          taskQueue: args.taskQueue,
          temporalAddress: args.address,
          temporalNamespace: args.namespace,
          status: "polling",
          lastSeenAt: new Date(),
          meta: {
            envSourcePath: shipfixEnvLoad.envSourcePath,
          },
        })
        .onConflictDoUpdate({
          target: workerHeartbeats.id,
          set: {
            taskQueue: args.taskQueue,
            temporalAddress: args.address,
            temporalNamespace: args.namespace,
            status: "polling",
            lastSeenAt: new Date(),
            meta: {
              envSourcePath: shipfixEnvLoad.envSourcePath,
            },
          },
        });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[shipfix-worker] heartbeat write failed:", err instanceof Error ? err.message : String(err));
    }
  };
  void beat();
  const interval = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[shipfix-worker] fatal:", err);
  process.exit(1);
});
