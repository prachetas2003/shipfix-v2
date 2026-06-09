export type AlphaLimitName =
  | "ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY"
  | "ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY"
  | "ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER"
  | "ALPHA_MAX_LLM_CALLS_PER_RUN"
  | "ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY"
  | "ALPHA_RATE_LIMIT_WINDOW_MS"
  | "ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW";

type AlphaLimitDefaults = Record<AlphaLimitName, number>;

export const PRODUCTION_ALPHA_DEFAULTS: AlphaLimitDefaults = {
  ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY: 3,
  ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY: 10,
  ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER: 1,
  ALPHA_MAX_LLM_CALLS_PER_RUN: 3,
  ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY: 20,
  ALPHA_RATE_LIMIT_WINDOW_MS: 60_000,
  ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW: 20,
};

export const DEVELOPMENT_ALPHA_DEFAULTS: AlphaLimitDefaults = {
  ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY: 50,
  ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY: 100,
  ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER: 3,
  ALPHA_MAX_LLM_CALLS_PER_RUN: 10,
  ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY: 200,
  ALPHA_RATE_LIMIT_WINDOW_MS: 60_000,
  ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW: 100,
};

export function alphaDefault(name: AlphaLimitName, nodeEnv = process.env.NODE_ENV): number {
  return nodeEnv === "production" ? PRODUCTION_ALPHA_DEFAULTS[name] : DEVELOPMENT_ALPHA_DEFAULTS[name];
}

export function alphaDefaultsProfile(nodeEnv = process.env.NODE_ENV): "production" | "development" {
  return nodeEnv === "production" ? "production" : "development";
}

export function usageLimitMessage(args: {
  code: string;
  limit: number;
  unit: string;
  nodeEnv?: string;
}): string {
  const base = `Usage limit reached: ${args.code} (${args.limit} ${args.unit}). Try again later.`;
  if (args.nodeEnv === "production") return base;
  return `${base} Increase the ALPHA_* limits in .env and restart the API/worker.`;
}
