import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import { unwrapFailureMessage } from "./errorMessages";

/**
 * The deployment WORKFLOW — the deterministic state machine.
 *
 * It contains NO I/O and NO non-determinism: it only orchestrates activities.
 * Temporal durably checkpoints every step, so this loop is automatically
 * resumable and retryable, which is what makes "intelligent recovery" and a
 * complete audit trail structural rather than bolted on.
 *
 * This skeleton wires the happy-path stage order. Human-in-the-loop signals,
 * managed-service provisioning, and the bounded recovery wrapper are marked
 * with TODOs and will be filled in as the activities become real.
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * Analysis fails FAST (single attempt). Clone/analyzer failures are
 * deterministic for a given commit, so retrying would only duplicate the run
 * timeline and slow down a clear diagnosis. Transient infra issues surface
 * immediately in dev; bounded recovery (later) will reintroduce smart retries.
 */
const analyzeActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Planning fails FAST (single attempt). The planner already retries the model
 * internally (one repair pass) and degrades to a deterministic fallback; a
 * Temporal-level retry would only duplicate the planning/validation timeline.
 */
const planActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Provisioning fails FAST (single attempt). Creating a managed resource is NOT
 * idempotent at most providers, so a blind Temporal retry could create
 * duplicates; the activity guards re-runs via the deployed_resources ledger.
 */
const deployActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});

export interface DeploymentWorkflowInput {
  runId: string;
  mode: "analyze_only" | "plan" | "deploy";
}

export async function deploymentWorkflow(
  input: DeploymentWorkflowInput,
): Promise<void> {
  try {
    // Stage 1 — deterministic analysis. This is the planner's only input.
    const ctx = await analyzeActs.analyzeRepo(input.runId);

    // analyze_only stops here: the validated RepoContext IS the deliverable.
    if (input.mode === "analyze_only") {
      await acts.completeRun(input.runId);
      return;
    }

    // Stage 2 — AI proposes a plan; the deterministic validator disposes. The
    // returned plan is already validated (classification downgraded as needed).
    await planActs.startPlanTransition(input.runId);
    const plan = await planActs.proposePlan(input.runId, ctx);

    // plan mode stops here: the validated DeploymentPlan IS the deliverable
    // (a deployment preview/diagnosis). No deployment is attempted.
    if (input.mode === "plan") {
      await acts.finalizePlanRun(input.runId, plan.classification);
      return;
    }

    // ── deploy mode: gate → provision → backend → frontend → verify → terminal ─
    // ShipFix only executes provider calls for GREEN (deployable) plans. YELLOW
    // /RED plans finalize as `diagnosed` here, before any provider is touched.
    const gate = await deployActs.gateDeploy(input.runId);
    if (!gate.allow) return;

    const provision = await deployActs.provisionManagedServices(input.runId);
    // Prisma migrate (direct URL) before services get the pooled runtime URL.
    await deployActs.runManagedMigrations(input.runId);
    const backendDeploy = await deployActs.deployBackendServices(input.runId);
    const frontendDeploy = await deployActs.deployFrontendServices(input.runId);
    // Apply deferred CORS/origin env now that the frontend URL exists.
    await deployActs.wireDeferredBackendEnv(input.runId);
    let verify: Awaited<ReturnType<typeof deployActs.verifyDeployedPlan>> = {
      passed: [],
      failed: [],
      skipped: [],
    };
    try {
      // Bounded recovery (C3): re-wire CORS + re-verify up to 2 times on failure.
      const recovery = await deployActs.verifySystem(input.runId);
      verify = recovery.verify;
    } finally {
      await acts.finalizeDeployRun(input.runId, {
        provision,
        backendDeploy,
        frontendDeploy,
        verify,
      });
    }
  } catch (err) {
    // Mark the run failed (best-effort) and let Temporal record the failure.
    await acts.failRun(input.runId, unwrapFailureMessage(err));
    throw err;
  }
}
