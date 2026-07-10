import { fileURLToPath } from "node:url";

export * as activities from "./activities";
export type { DeploymentWorkflowInput } from "./workflows";
export {
  reconcileStuckRuns,
  reconcileStuckRunsFromEnv,
  type ReconcileStuckRunResult,
  type ReconcileStuckRunsOptions,
  type ReconcileStuckRunsSummary,
} from "./reconcileStuckRuns.js";
export {
  revalidatePlanForRun,
  type RevalidateResult,
} from "./revalidatePlan.js";
export {
  assertProductionEnv,
  validateProductionEnv,
  type ProductionEnvValidation,
} from "./productionEnv.js";

export const TASK_QUEUE = "shipfix";

/**
 * Absolute path to the workflows module, for the worker's `workflowsPath`.
 * Temporal bundles workflow code into an isolated v8 context; it must be loaded
 * by path, not imported into the worker's main module.
 */
export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
