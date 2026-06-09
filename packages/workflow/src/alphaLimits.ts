export type WorkflowAlphaLimitName =
  | "ALPHA_MAX_LLM_CALLS_PER_RUN"
  | "ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY";

const PRODUCTION_DEFAULTS: Record<WorkflowAlphaLimitName, number> = {
  ALPHA_MAX_LLM_CALLS_PER_RUN: 3,
  ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY: 20,
};

const DEVELOPMENT_DEFAULTS: Record<WorkflowAlphaLimitName, number> = {
  ALPHA_MAX_LLM_CALLS_PER_RUN: 10,
  ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY: 200,
};

export function workflowAlphaDefault(name: WorkflowAlphaLimitName, nodeEnv = process.env.NODE_ENV): number {
  return nodeEnv === "production" ? PRODUCTION_DEFAULTS[name] : DEVELOPMENT_DEFAULTS[name];
}

export function workflowAlphaLimit(name: WorkflowAlphaLimitName, nodeEnv = process.env.NODE_ENV): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : workflowAlphaDefault(name, nodeEnv);
}

export function llmUsageLimitMessage(args: {
  code: "llm_run_limit" | "llm_daily_user_limit";
  limit: number;
  nodeEnv?: string;
}): string {
  const unit = args.code === "llm_run_limit" ? "LLM calls per run" : "LLM calls per user per day";
  const base = `Usage limit reached: ${args.code} (${args.limit} ${unit}). Try again later.`;
  if (args.nodeEnv === "production") return base;
  return `${base} Increase the ALPHA_* limits in .env and restart the API/worker.`;
}
