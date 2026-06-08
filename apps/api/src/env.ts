import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { z } from "zod";

// Load the repo-root .env for local dev (no-op if the file is absent, so real
// shell-exported env still works). Must run before parsing below.
loadEnvFile({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

/**
 * Validated control-plane environment. Fails fast at boot if misconfigured so a
 * half-configured API never half-works. Never logs values.
 */
const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("shipfix"),
  /** Allowed browser origin for the web app (CORS). "*" in dev. */
  WEB_ORIGIN: z.string().default("*"),
  /**
   * Base64 32-byte master key for the SecretVault. Optional at boot so the
   * analyze/plan flows work without it; the credential-connect route checks for
   * it and fails with a clear error when absent.
   */
  SHIPFIX_MASTER_KEY: z.string().optional(),
  /**
   * Comma-separated alpha users as login:token. Tokens are never returned to the
   * browser by the API; alpha clients send one as X-ShipFix-Alpha-User.
   */
  ALPHA_USER_TOKENS: z.string().optional(),
  /** Required for /admin/* routes. If absent, admin routes are disabled. */
  SHIPFIX_ADMIN_TOKEN: z.string().optional(),
  ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(3),
  ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(10),
  ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER: z.coerce.number().int().positive().default(1),
  ALPHA_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW: z.coerce.number().int().positive().default(20),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
