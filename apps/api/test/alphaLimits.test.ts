import { describe, expect, it } from "vitest";
import { alphaDefault, usageLimitMessage } from "../src/alphaLimits";
import { EnvSchema } from "../src/env";

describe("API alpha limit defaults", () => {
  it("uses higher defaults outside production for local testing", () => {
    expect(alphaDefault("ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY", "development")).toBe(50);
    expect(alphaDefault("ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY", "development")).toBe(100);
    expect(alphaDefault("ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER", "development")).toBe(3);
    expect(alphaDefault("ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW", "development")).toBe(100);
  });

  it("keeps conservative production defaults unless env vars override them", () => {
    expect(alphaDefault("ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY", "production")).toBe(3);
    expect(alphaDefault("ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY", "production")).toBe(10);
    expect(alphaDefault("ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER", "production")).toBe(1);
    expect(alphaDefault("ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW", "production")).toBe(20);
  });

  it("lets explicit env vars override local defaults", () => {
    const parsed = EnvSchema.parse({
      DATABASE_URL: "postgres://shipfix:shipfix@localhost:5432/shipfix",
      ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY: "77",
      ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER: "8",
    });
    expect(parsed.ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY).toBe(77);
    expect(parsed.ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER).toBe(8);
  });

  it("includes the specific limit code and a dev-only hint", () => {
    const message = usageLimitMessage({
      code: "daily_run_limit",
      limit: 100,
      unit: "plan/analyze runs per user per day",
      nodeEnv: "development",
    });
    expect(message).toContain("daily_run_limit");
    expect(message).toContain("100 plan/analyze runs per user per day");
    expect(message).toContain("Increase the ALPHA_* limits");
  });

  it("does not include the dev hint in production messages", () => {
    const message = usageLimitMessage({
      code: "active_deploy_limit",
      limit: 1,
      unit: "active deploy runs per user",
      nodeEnv: "production",
    });
    expect(message).toContain("active_deploy_limit");
    expect(message).not.toContain("Increase the ALPHA_* limits");
  });
});
