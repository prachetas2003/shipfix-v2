import { describe, expect, it, vi } from "vitest";
import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const ctx: RepoContext = {
    repoFullName: "acme/app",
    commitSha: "abc123",
    fileTree: [],
    services: [],
    dataNeeds: [],
    envRefs: [],
    hardcodedUrls: [],
    monorepoTool: "none",
  };
  const plan: DeploymentPlan = {
    goal: "Deploy app",
    classification: "deployable",
    services: [],
    managed: [],
    wiring: [],
    deployOrder: [],
    questions: [],
    blockers: [],
    verification: [],
    confidence: 0.8,
  };
  return { calls, ctx, plan };
});

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    analyzeRepo: async () => {
      h.calls.push("analyzeRepo");
      return h.ctx;
    },
    startPlanTransition: async () => {
      h.calls.push("startPlanTransition");
    },
    proposePlan: async () => {
      h.calls.push("proposePlan");
      return h.plan;
    },
    finalizePlanRun: async () => {
      h.calls.push("finalizePlanRun");
    },
    completeRun: async () => {
      h.calls.push("completeRun");
    },
    failRun: async () => {
      h.calls.push("failRun");
    },
  }),
}));

describe("deploymentWorkflow analyze -> plan transition", () => {
  it("emits the planning transition activity before proposing a plan", async () => {
    h.calls.length = 0;
    const { deploymentWorkflow } = await import("../src/workflows");

    await deploymentWorkflow({
      runId: "11111111-1111-4111-8111-111111111111",
      mode: "plan",
    });

    expect(h.calls).toEqual([
      "analyzeRepo",
      "startPlanTransition",
      "proposePlan",
      "finalizePlanRun",
    ]);
  });
});
