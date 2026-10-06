import { describe, expect, it } from "vitest";
import { assertProductionEnv, validateProductionEnv } from "../src/productionEnv";

const validEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@example.com:5432/shipfix",
  SHIPFIX_MASTER_KEY: Buffer.alloc(32).toString("base64"),
  SHIPFIX_ADMIN_TOKEN: "admin-token",
  TEMPORAL_ADDRESS: "temporal:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "shipfix-prod",
  WEB_ORIGIN: "https://shipfix.example.com",
  AUTH_MODE: "clerk",
  LLM_PROVIDER: "openai",
  LLM_MODEL: "gpt-4o-mini",
  OPENAI_API_KEY: "sk-prod",
  NEON_API_KEY: "neon-key",
  NEON_ORG_ID: "org-id",
  RENDER_API_KEY: "render-key",
  VERCEL_TOKEN: "vercel-token",
  CLERK_SECRET_KEY: "sk_clerk",
} satisfies NodeJS.ProcessEnv;

describe("production env validation", () => {
  it("accepts the required production API/worker env", () => {
    expect(validateProductionEnv(validEnv)).toEqual({ ok: true, missing: [], invalid: [] });
    expect(() => assertProductionEnv("api", validEnv)).not.toThrow();
  });

  it("requires provider-specific LLM keys", () => {
    const env = { ...validEnv, LLM_PROVIDER: "gemini", OPENAI_API_KEY: undefined };
    const result = validateProductionEnv(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("GEMINI_API_KEY");
  });

  it("requires the fixed production Temporal task queue", () => {
    const result = validateProductionEnv({ ...validEnv, TEMPORAL_TASK_QUEUE: "shipfix-local" });
    expect(result.ok).toBe(false);
    expect(result.invalid).toContain("TEMPORAL_TASK_QUEUE must be shipfix-prod in production");
  });

  it("requires an isolated sandbox for the worker", () => {
    expect(validateProductionEnv(validEnv, "worker").missing).toContain("E2B_API_KEY");
    const local = validateProductionEnv({ ...validEnv, E2B_API_KEY: "e2b", SHIPFIX_SANDBOX: "local" }, "worker");
    expect(local.invalid).toContain("SHIPFIX_SANDBOX must be e2b in production");
    expect(validateProductionEnv({ ...validEnv, E2B_API_KEY: "e2b" }, "worker").ok).toBe(true);
  });

  it("does not enforce production requirements outside production", () => {
    expect(() => assertProductionEnv("worker", { NODE_ENV: "development" })).not.toThrow();
  });
});
