import { describe, expect, it } from "vitest";
import type { DeploymentPlan } from "@shipfix/contracts";
import { questionForSetting, settingGuide } from "@shipfix/contracts";
import { isSettingName, shouldWaitForInput, withMissingSettings } from "../src/inputWait";

function plan(over: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    goal: "Deploy",
    classification: "needs_setup",
    services: [
      {
        id: "api",
        type: "node_api",
        provider: "render",
        rootDir: "",
        install: null,
        build: null,
        start: null,
        outputDir: null,
        healthCheckPath: null,
        env: [],
        evidence: [],
      },
    ],
    managed: [],
    wiring: [],
    deployOrder: ["api"],
    questions: [
      { id: "secret-api-STRIPE_SECRET_KEY", prompt: "Paste your Stripe key", kind: "secret", blocksServiceIds: ["api"] },
    ],
    blockers: [],
    verification: [],
    confidence: 0.5,
    ...over,
  };
}

describe("shouldWaitForInput", () => {
  it("waits for an unanswered setup question", () => {
    expect(shouldWaitForInput(plan(), new Set())).toBe(true);
  });

  it("continues once the question or the same project env is satisfied", () => {
    expect(shouldWaitForInput(plan(), new Set(["secret-api-STRIPE_SECRET_KEY"]))).toBe(false);
    expect(shouldWaitForInput(plan(), new Set(), new Set(["STRIPE_SECRET_KEY"]))).toBe(false);
  });

  it("does not wait on a diagnosis or a setup plan with no questions", () => {
    expect(shouldWaitForInput(plan({ classification: "diagnose_only" }), new Set())).toBe(false);
    expect(shouldWaitForInput(plan({ questions: [] }), new Set())).toBe(false);
    expect(shouldWaitForInput(plan({ classification: "deployable" }), new Set())).toBe(false);
  });
});

describe("withMissingSettings", () => {
  it("adds a guided secret question and a user_secret env", () => {
    const next = withMissingSettings(plan({ classification: "deployable", questions: [] }), [
      { serviceId: "api", envName: "OPENAI_API_KEY" },
    ]);
    expect(next.questions[0]).toMatchObject({
      id: "secret-api-OPENAI_API_KEY",
      kind: "secret",
      helpUrl: "https://platform.openai.com/api-keys",
    });
    expect(next.services[0]!.env).toEqual([{ name: "OPENAI_API_KEY", source: "user_secret" }]);
    expect(plan({ classification: "deployable", questions: [] }).questions).toEqual([]);
  });

  it("ignores values that are not env names and does not duplicate", () => {
    const once = withMissingSettings(plan({ questions: [] }), [{ serviceId: "api", envName: "STRIPE_SECRET_KEY" }]);
    const twice = withMissingSettings(once, [
      { serviceId: "api", envName: "STRIPE_SECRET_KEY" },
      { serviceId: "api", envName: "not-an-env" },
    ]);
    expect(twice.questions.map((q) => q.id)).toEqual(["secret-api-STRIPE_SECRET_KEY"]);
    expect(twice.services[0]!.env).toHaveLength(1);
    expect(isSettingName("sk_live_123")).toBe(false);
  });
});

describe("setting guides", () => {
  it("points Stripe and unknown settings at different guidance", () => {
    expect(settingGuide("STRIPE_SECRET_KEY").helpUrl).toBe("https://dashboard.stripe.com/apikeys");
    expect(questionForSetting("api", "CUSTOM_TOKEN").help).toContain("CUSTOM_TOKEN");
    expect(questionForSetting("api", "CUSTOM_TOKEN").helpUrl).toBeUndefined();
  });
});
