import { describe, expect, it, vi } from "vitest";
import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  waits: 0,
  signal: null as (() => void) | null,
}));

vi.mock("@temporalio/workflow", () => ({
  defineSignal: (name: string) => name,
  patched: (name: string) => name === "awaiting-input-v1",
  setHandler: (_signal: string, handler: () => void) => {
    h.signal = handler;
  },
  condition: async (fn: () => boolean) => fn(),
  proxyActivities: () => ({
    analyzeRepo: async () =>
      ({
        repoFullName: "acme/app",
        commitSha: "abc",
        fileTree: [],
        services: [],
        dataNeeds: [],
        envRefs: [],
        hardcodedUrls: [],
        publicEnv: [],
        companions: [],
        monorepoTool: "none",
      }) satisfies RepoContext,
    startPlanTransition: async () => {},
    proposePlan: async () =>
      ({
        goal: "Deploy",
        classification: "needs_setup",
        services: [],
        managed: [],
        wiring: [],
        deployOrder: [],
        questions: [],
        blockers: [],
        verification: [],
        confidence: 0.5,
      }) satisfies DeploymentPlan,
    finalizePlanRun: async () => {},
    completeRun: async () => {},
    failRun: async () => {},
    beginInputWait: async () => {
      h.calls.push("beginInputWait");
      h.waits += 1;
      if (h.waits === 1) {
        h.signal?.();
        return { waiting: true };
      }
      return { waiting: false };
    },
    noteInputWaitExpired: async () => {
      h.calls.push("noteInputWaitExpired");
    },
    gateDeploy: async () => {
      h.calls.push("gateDeploy");
      return { allow: false };
    },
  }),
}));

describe("deploymentWorkflow input wait", () => {
  it("pauses for an answer, then continues to the deploy gate", async () => {
    h.calls.length = 0;
    h.waits = 0;
    const { deploymentWorkflow } = await import("../src/workflows");
    await deploymentWorkflow({ runId: "11111111-1111-4111-8111-111111111111", mode: "deploy" });
    expect(h.calls).toEqual(["beginInputWait", "beginInputWait", "gateDeploy"]);
  });
});
