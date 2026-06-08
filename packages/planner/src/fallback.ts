import { DeploymentPlan } from "@shipfix/contracts";
import type { DeploymentPlan as DeploymentPlanType } from "@shipfix/contracts";

/**
 * The deterministic safety net when the model cannot produce schema-valid
 * output. A failed planner is itself a diagnosis: we return a valid, honest
 * `diagnose_only` plan rather than crashing or fabricating a deployment.
 */
export function invalidPlanFallback(reason: string): DeploymentPlanType {
  return DeploymentPlan.parse({
    goal: "Unable to produce a deployment plan from the available evidence.",
    classification: "diagnose_only",
    services: [],
    managed: [],
    wiring: [],
    deployOrder: [],
    questions: [],
    blockers: [
      {
        severity: "fatal",
        title: "Planner could not produce a valid plan",
        explanation: reason,
        action:
          "Re-run analysis, or inspect the repository manually. The planner output did not conform to the DeploymentPlan contract.",
        autoFixable: false,
        evidence: [],
      },
    ],
    verification: [],
    confidence: 0,
  });
}
