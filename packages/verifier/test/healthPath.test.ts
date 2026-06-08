import { describe, it, expect } from "vitest";
import type { DeploymentPlan } from "@shipfix/contracts";
import { resolveHealthPath } from "../src/healthPath";

describe("resolveHealthPath", () => {
  const plan: DeploymentPlan = {
    goal: "x",
    classification: "deployable",
    services: [],
    managed: [],
    wiring: [],
    deployOrder: [],
    questions: [],
    blockers: [],
    verification: [{ serviceId: "api", check: "health_path", target: "/health" }],
    confidence: 1,
  };

  it("uses plan verification target", () => {
    expect(resolveHealthPath(plan, "api", null).path).toBe("/health");
  });

  it("does not default to root when path is missing", () => {
    const bare: DeploymentPlan = { ...plan, verification: [{ serviceId: "api", check: "http_2xx" }] };
    expect(resolveHealthPath(bare, "api", null).path).toBeNull();
  });

  it("falls back to service healthCheckPath", () => {
    const bare: DeploymentPlan = { ...plan, verification: [] };
    expect(resolveHealthPath(bare, "api", "/ready").path).toBe("/ready");
  });
});
