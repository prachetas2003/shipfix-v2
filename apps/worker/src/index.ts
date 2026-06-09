import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { NativeConnection, Worker } from "@temporalio/worker";
import { activities, TASK_QUEUE, workflowsPath } from "@shipfix/workflow";

// Load repo-root .env for local dev, then allow worker-local overrides.
// Activities read DATABASE_URL, Temporal, provider, and LLM config at runtime.
const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const workerEnvPath = fileURLToPath(new URL("../.env.local", import.meta.url));
const rootEnvResult = loadEnvFile({ path: rootEnvPath });
const workerEnvResult = loadEnvFile({ path: workerEnvPath, override: true });

function providerKeyEnv(provider: string | undefined): string | null {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "openai") return "OPENAI_API_KEY";
  if (normalized === "anthropic") return "ANTHROPIC_API_KEY";
  if (normalized === "gemini") return "GEMINI_API_KEY";
  return null;
}

function logSafeEnvDiagnostic(): void {
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const expectedKey = providerKeyEnv(provider);
  const acceptedProvider = provider === "openai" || provider === "anthropic" || provider === "gemini";
  const legacyFallbackPresent = Boolean(process.env.LLM_API_KEY?.trim());
  // eslint-disable-next-line no-console
  console.log("[shipfix-worker] env diagnostic", {
    cwd: process.cwd(),
    rootEnvPath,
    rootEnvExists: existsSync(rootEnvPath),
    rootEnvLoaded: !rootEnvResult.error,
    workerEnvPath,
    workerEnvExists: existsSync(workerEnvPath),
    workerEnvLoaded: !workerEnvResult.error,
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
 *
 * The worker registers workflow code (bundled into an isolated context by
 * Temporal) and the activity implementations (which do the real I/O).
 */

async function run(): Promise<void> {
  logSafeEnvDiagnostic();
  const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shipfix-worker] DATABASE_URL is not set — analyze activities will fail. " +
        "Set it in .env or the shell before running.",
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
    taskQueue: TASK_QUEUE,
    namespace: process.env.TEMPORAL_NAMESPACE || "default",
  });

  // eslint-disable-next-line no-console
  console.log(
    `[shipfix-worker] connected to Temporal at ${address}; polling task queue "${TASK_QUEUE}"`,
  );
  await worker.run();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[shipfix-worker] fatal:", err);
  process.exit(1);
});
