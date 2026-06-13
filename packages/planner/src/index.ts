/**
 * @shipfix/planner — the deployment planning brain.
 *
 * Deterministic-first: repos that fully fit the supported slice are planned in
 * code from analyzer evidence (reproducible, zero LLM calls). Everything else:
 * RepoContext (deterministic evidence) -> LLM gateway -> schema-valid
 * DeploymentPlan. The planner only PROPOSES: it grounds the model in evidence,
 * forces output through the DeploymentPlan contract, and degrades to an honest
 * `diagnose_only` plan when the model can't conform. Deterministic validation
 * (the `@shipfix/validator` trust boundary) is applied by the caller afterward
 * — synthesized plans get no special trust.
 */
export { generatePlan, type GeneratePlanResult, type PlannerOptions } from "./generate";
export { synthesizeDeterministicPlan } from "./synthesize";
export { invalidPlanFallback } from "./fallback";
export { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from "./prompt";
