import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { NativeConnection, Worker } from "@temporalio/worker";
import { activities, TASK_QUEUE, workflowsPath } from "@shipfix/workflow";

// Load repo-root .env for local dev (no-op if absent). Activities read
// DATABASE_URL / Temporal config from process.env at runtime.
loadEnvFile({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

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
  const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shipfix-worker] DATABASE_URL is not set — analyze activities will fail. " +
        "Set it in .env or the shell before running.",
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
