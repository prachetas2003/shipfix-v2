/**
 * @shipfix/planner — the deployment planning brain.
 *
 * RepoContext (deterministic evidence) -> LLM gateway -> schema-valid
 * DeploymentPlan. The planner only PROPOSES: it grounds the model in evidence,
 * forces output through the DeploymentPlan contract, and degrades to an honest
 * `diagnose_only` plan when the model can't conform. Deterministic validation
 * (the `@shipfix/validator` trust boundary) is applied by the caller afterward.
 */
export { generatePlan, type GeneratePlanResult, type PlannerOptions } from "./generate";
export { invalidPlanFallback } from "./fallback";
export { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from "./prompt";
