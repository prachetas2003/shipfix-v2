import { afterEach, describe, expect, it } from "vitest";
import { llmUsageLimitMessage, workflowAlphaDefault, workflowAlphaLimit } from "../src/alphaLimits";

describe("workflow alpha LLM limits", () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("uses higher local/dev defaults", () => {
    expect(workflowAlphaDefault("ALPHA_MAX_LLM_CALLS_PER_RUN", "development")).toBe(10);
    expect(workflowAlphaDefault("ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY", "development")).toBe(200);
  });

  it("keeps conservative production defaults", () => {
    expect(workflowAlphaDefault("ALPHA_MAX_LLM_CALLS_PER_RUN", "production")).toBe(3);
    expect(workflowAlphaDefault("ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY", "production")).toBe(20);
  });

  it("allows env vars to override defaults", () => {
    process.env = { ...OLD_ENV, ALPHA_MAX_LLM_CALLS_PER_RUN: "42" };
    expect(workflowAlphaLimit("ALPHA_MAX_LLM_CALLS_PER_RUN", "development")).toBe(42);
    expect(workflowAlphaLimit("ALPHA_MAX_LLM_CALLS_PER_RUN", "production")).toBe(42);
  });

  it("includes a specific LLM limit code and dev-only hint", () => {
    const dev = llmUsageLimitMessage({ code: "llm_run_limit", limit: 10, nodeEnv: "development" });
    expect(dev).toContain("llm_run_limit");
    expect(dev).toContain("10 LLM calls per run");
    expect(dev).toContain("Increase the ALPHA_* limits");

    const prod = llmUsageLimitMessage({ code: "llm_daily_user_limit", limit: 20, nodeEnv: "production" });
    expect(prod).toContain("llm_daily_user_limit");
    expect(prod).not.toContain("Increase the ALPHA_* limits");
  });
});
