import { condition, defineSignal, patched, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";
import { unwrapFailureMessage } from "./errorMessages";
import { mergeDeploySummary } from "./deploySummary";
import { INPUT_WAIT_TIMEOUT, INPUTS_SUBMITTED_SIGNAL, MAX_INPUT_ROUNDS } from "./signals";

/** Fired by the API after it saves answers for a run that is paused on a question. */
export const inputsSubmitted = defineSignal(INPUTS_SUBMITTED_SIGNAL);

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

/**
 * Repair rebuilds candidate fixes in a sandbox (install + build per attempt),
 * so it gets a long budget. Single attempt: it records what it tried, and a
 * blind retry would repeat paid model calls.
 */
const repairActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "45 minutes",
  retry: { maximumAttempts: 1 },
});

/** Repair → redeploy cycles per run. Each repair already makes several verified attempts. */
const MAX_REPAIR_ROUNDS = 2;

type InputWaitResult = "not_needed" | "answered" | "expired";

/**
 * Pause while the plan still needs an answer. Each saved answer signals the
 * workflow; the next check revalidates and either continues or asks again.
 */
async function waitForAnswers(
  runId: string,
  signals: { n: number },
): Promise<InputWaitResult> {
  let answered = false;
  for (let round = 0; round < MAX_INPUT_ROUNDS; round++) {
    const seen = signals.n;
    const wait = await deployActs.beginInputWait(runId);
    if (!wait.waiting) return answered ? "answered" : "not_needed";
    const got = await condition(() => signals.n > seen, INPUT_WAIT_TIMEOUT);
    if (!got) {
      await deployActs.noteInputWaitExpired(runId);
      return "expired";
    }
    answered = true;
  }
  return "answered";
}

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

    // ── deploy mode: ask → gate → provision → backend → frontend → verify ─
    // A plan that only needs a secret pauses here. The same run continues
    // after the answer, instead of stopping and making the user start over.
    const signals = { n: 0 };
    if (patched("awaiting-input-v1")) {
      setHandler(inputsSubmitted, () => {
        signals.n += 1;
      });
      const waited = await waitForAnswers(input.runId, signals);
      if (waited === "expired") return;
    }

    // ShipFix only executes provider calls for GREEN (deployable) plans. YELLOW
    // /RED plans finalize as `diagnosed` here, before any provider is touched.
    const gate = await deployActs.gateDeploy(input.runId);
    if (!gate.allow) return;

    const provision = await deployActs.provisionManagedServices(input.runId);
    // Prisma migrate (direct URL) before services get the pooled runtime URL.
    await deployActs.runManagedMigrations(input.runId);
    await deployActs.applySupabaseMigrations(input.runId);
    let backendDeploy = await deployActs.deployBackendServices(input.runId);
    let frontendDeploy = await deployActs.deployFrontendServices(input.runId);
    if (patched("autofix-repair-v1")) {
      for (
        let round = 0;
        round < MAX_REPAIR_ROUNDS && backendDeploy.failed.length + frontendDeploy.failed.length > 0;
        round++
      ) {
        const repair = await repairActs.repairFailedDeploys(input.runId);
        let answered = false;
        if (patched("awaiting-input-v1") && (repair.asked?.length ?? 0) > 0) {
          const waited = await waitForAnswers(input.runId, signals);
          if (waited === "expired") break;
          answered = waited === "answered";
        }
        if (repair.retry.length === 0 && !answered) break;
        backendDeploy = mergeDeploySummary(backendDeploy, await deployActs.deployBackendServices(input.runId));
        frontendDeploy = mergeDeploySummary(frontendDeploy, await deployActs.deployFrontendServices(input.runId));
      }
    }
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
