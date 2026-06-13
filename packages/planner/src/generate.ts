import { DeploymentPlan } from "@shipfix/contracts";
import type { DeploymentPlan as DeploymentPlanType, PlanSource, RepoContext } from "@shipfix/contracts";
import { parseStructured, type LLMGateway } from "@shipfix/llm";
import { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from "./prompt";
import { invalidPlanFallback } from "./fallback";
import { synthesizeDeterministicPlan } from "./synthesize";

export interface PlannerOptions {
  /** Number of follow-up repair attempts after the first try. Default 1. */
  maxRepairAttempts?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Skip deterministic synthesis and force the LLM path (tests/debugging). */
  disableSynthesis?: boolean;
}

export interface GeneratePlanResult {
  /** Always schema-valid: synthesized, model-parsed, or the fallback. */
  plan: DeploymentPlanType;
  model: string;
  /** Total gateway calls made (0 for deterministic synthesis). */
  attempts: number;
  /** True when the diagnose-only fallback plan was returned. */
  usedFallback: boolean;
  /** How the plan was produced. */
  planSource: PlanSource;
  /** Raw text of the last model response (for debugging/observability). */
  raw: string;
}

/**
 * RepoContext -> DeploymentPlan, deterministic-first.
 *
 * Repos whose evidence fully fits the supported slice are planned in code
 * (reproducible; zero LLM calls). Everything else goes through the LLM
 * proposal path: output is only returned after passing `parseStructured`
 * against the DeploymentPlan contract; if the model never conforms, we degrade
 * to an honest `diagnose_only` fallback. The planner does NOT run the
 * deterministic validator — that is a separate trust boundary applied by the
 * caller after planning (for synthesized plans too: no special trust).
 */
export async function generatePlan(
  ctx: RepoContext,
  gateway: LLMGateway,
  opts: PlannerOptions = {},
): Promise<GeneratePlanResult> {
  if (!opts.disableSynthesis) {
    const synthesized = synthesizeDeterministicPlan(ctx);
    if (synthesized) {
      return {
        plan: synthesized,
        model: "deterministic",
        attempts: 0,
        usedFallback: false,
        planSource: "deterministic",
        raw: "",
      };
    }
  }

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
      return {
        plan: { ...parsed.data, planSource: "llm" },
        model: res.model,
        attempts,
        usedFallback: false,
        planSource: "llm",
        raw: res.text,
      };
    }

    // Not conforming — ask the model to repair on the next iteration.
    user = buildRepairPrompt(baseUser, res.text, parsed.error);
  }

  return {
    plan: {
      ...invalidPlanFallback(`Planner produced invalid output after ${attempts} attempt(s).`),
      planSource: "llm_fallback",
    },
    model: gateway.model,
    attempts,
    usedFallback: true,
    planSource: "llm_fallback",
    raw: lastRaw,
  };
}
