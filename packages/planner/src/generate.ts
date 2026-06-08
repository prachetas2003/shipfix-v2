import { DeploymentPlan } from "@shipfix/contracts";
import type { DeploymentPlan as DeploymentPlanType, RepoContext } from "@shipfix/contracts";
import { parseStructured, type LLMGateway } from "@shipfix/llm";
import { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from "./prompt";
import { invalidPlanFallback } from "./fallback";

export interface PlannerOptions {
  /** Number of follow-up repair attempts after the first try. Default 1. */
  maxRepairAttempts?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeneratePlanResult {
  /** Always schema-valid: either the model's parsed output or the fallback. */
  plan: DeploymentPlanType;
  model: string;
  /** Total gateway calls made (1 + repairs used). */
  attempts: number;
  /** True when the deterministic fallback plan was returned. */
  usedFallback: boolean;
  /** Raw text of the last model response (for debugging/observability). */
  raw: string;
}

/**
 * RepoContext -> LLM -> schema-valid DeploymentPlan.
 *
 * The gateway is injected (the caller decides real vs. test), so the planner
 * itself stays pure and fully unit-testable. Output is only ever returned after
 * passing `parseStructured` against the DeploymentPlan contract; if the model
 * never conforms, we degrade to an honest `diagnose_only` fallback. The planner
 * does NOT run the deterministic validator — that is a separate trust boundary
 * applied by the caller after planning.
 */
export async function generatePlan(
  ctx: RepoContext,
  gateway: LLMGateway,
  opts: PlannerOptions = {},
): Promise<GeneratePlanResult> {
  const maxRepairs = opts.maxRepairAttempts ?? 1;
  const system = buildSystemPrompt();
  const baseUser = buildUserPrompt(ctx);

  let user = baseUser;
  let lastRaw = "";
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    attempts++;
    const res = await gateway.complete({
      system,
      user,
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
    });
    lastRaw = res.text;

    const parsed = parseStructured(res.text, DeploymentPlan);
    if (parsed.ok) {
      return { plan: parsed.data, model: res.model, attempts, usedFallback: false, raw: res.text };
    }

    // Not conforming — ask the model to repair on the next iteration.
    user = buildRepairPrompt(baseUser, res.text, parsed.error);
  }

  return {
    plan: invalidPlanFallback(`Planner produced invalid output after ${attempts} attempt(s).`),
    model: gateway.model,
    attempts,
    usedFallback: true,
    raw: lastRaw,
  };
}
