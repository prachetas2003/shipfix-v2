import { fileURLToPath } from "node:url";
import { effectiveTemporalTaskQueue, loadShipfixEnv, logDatabaseFingerprint } from "@shipfix/db";
import { assertProductionEnv } from "@shipfix/workflow/productionEnv";
import { z } from "zod";
import { alphaDefault } from "./alphaLimits";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const appLocalEnvPath = fileURLToPath(new URL("../.env.local", import.meta.url));

/** Shared with worker: repo-root `.env` then app-local overrides. */
export const shipfixEnvLoad = loadShipfixEnv({
  rootEnvPath,
  appLocalEnvPath,
  rootOverride: process.env.NODE_ENV !== "production",
});

logDatabaseFingerprint("shipfix-api", process.env.DATABASE_URL, shipfixEnvLoad);

/**
 * Validated control-plane environment. Fails fast at boot if misconfigured so a
 * half-configured API never half-works. Never logs values.
 */
const BaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_PORT: z.preprocess(
    (value) => value ?? process.env.PORT ?? 4000,
    z.coerce.number().int().positive(),
  ),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().optional(),
  /** Allowed browser origin for the web app (CORS). "*" in dev. */
  WEB_ORIGIN: z.string().default("*"),
  /**
   * Base64 32-byte master key for the SecretVault. Optional at boot so the
   * analyze/plan flows work without it; the credential-connect route checks for
   * it and fails with a clear error when absent.
   */
  SHIPFIX_MASTER_KEY: z.string().optional(),
  AUTH_MODE: z.enum(["clerk", "dev"]).default("clerk"),
  CLERK_SECRET_KEY: z.string().optional(),
  /** Required for /admin/* routes. If absent, admin routes are disabled. */
  SHIPFIX_ADMIN_TOKEN: z.string().optional(),
  ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY")),
  ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY")),
  ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER")),
  ALPHA_MAX_LLM_CALLS_PER_RUN: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_LLM_CALLS_PER_RUN")),
  ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY")),
  ALPHA_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(alphaDefault("ALPHA_RATE_LIMIT_WINDOW_MS")),
  ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW: z.coerce.number().int().positive().default(alphaDefault("ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW")),
  /** Optional GitHub App credentials for private clone + push webhooks. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
});

export const EnvSchema = BaseEnvSchema.transform((value) => ({
  ...value,
  TEMPORAL_TASK_QUEUE: effectiveTemporalTaskQueue(
    value.TEMPORAL_TASK_QUEUE,
    value.DATABASE_URL,
    process.env.NODE_ENV,
  ),
}));

export const env = EnvSchema.parse(process.env);
assertProductionEnv("api", process.env);
export type Env = z.infer<typeof EnvSchema>;
