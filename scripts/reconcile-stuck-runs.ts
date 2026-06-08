/**
 * Reconcile runs stuck in deploying/provisioning/etc. after worker crashes.
 *
 * Usage:
 *   DATABASE_URL=... pnpm reconcile-stuck-runs
 *   DATABASE_URL=... pnpm reconcile-stuck-runs -- --dry-run
 */
import { reconcileStuckRunsFromEnv } from "../packages/workflow/src/reconcileStuckRuns.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const olderArg = args.find((a) => a.startsWith("--older-than-minutes="));
const olderThanMs = olderArg
  ? Number(olderArg.split("=")[1]) * 60 * 1000
  : 20 * 60 * 1000;

const summary = await reconcileStuckRunsFromEnv({ dryRun, olderThanMs });
console.log(JSON.stringify(summary, null, 2));
