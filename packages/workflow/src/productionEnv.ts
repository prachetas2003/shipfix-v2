const REQUIRED_PRODUCTION_ENV = [
  "DATABASE_URL",
  "SHIPFIX_MASTER_KEY",
  "SHIPFIX_ADMIN_TOKEN",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE",
  "WEB_ORIGIN",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "NEON_API_KEY",
  "NEON_ORG_ID",
  "RENDER_API_KEY",
  "VERCEL_TOKEN",
  "CLERK_SECRET_KEY",
] as const;

const LLM_PROVIDER_KEYS = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;

export interface ProductionEnvValidation {
  ok: boolean;
  missing: string[];
  invalid: string[];
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): ProductionEnvValidation {
  const missing: string[] = REQUIRED_PRODUCTION_ENV.filter((name) => !present(env, name));
  const invalid: string[] = [];

  if (env.AUTH_MODE && env.AUTH_MODE !== "clerk") {
    invalid.push("AUTH_MODE must be clerk in production");
  }

  if (env.TEMPORAL_TASK_QUEUE && env.TEMPORAL_TASK_QUEUE !== "shipfix-prod") {
    invalid.push("TEMPORAL_TASK_QUEUE must be shipfix-prod in production");
  }

  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider && !(provider in LLM_PROVIDER_KEYS)) {
    invalid.push("LLM_PROVIDER must be openai, gemini, or anthropic");
  }

  const providerKey = provider ? LLM_PROVIDER_KEYS[provider as keyof typeof LLM_PROVIDER_KEYS] : null;
  if (providerKey && !present(env, providerKey)) {
    missing.push(providerKey);
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    missing: [...new Set(missing)].sort(),
    invalid: [...new Set(invalid)].sort(),
  };
}

export function assertProductionEnv(
  serviceName: "api" | "worker",
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;

  const result = validateProductionEnv(env);
  if (result.ok) return;

  const parts = [
    result.missing.length ? `missing: ${result.missing.join(", ")}` : null,
    result.invalid.length ? `invalid: ${result.invalid.join("; ")}` : null,
  ].filter(Boolean);
  throw new Error(`[shipfix-${serviceName}] production environment is not ready (${parts.join(" | ")}).`);
}
