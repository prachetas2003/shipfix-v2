import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";
import { validatePlan, capabilities, emptyCapabilities } from "../src/index";

const fullCaps = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api", "worker"] },
  ["neon"],
);

const ctx: RepoContext = {
  repoFullName: "acme/app",
  commitSha: "abc",
  fileTree: ["apps/api/src/index.ts"],
  services: [
    {
      rootDir: "apps/api",
      language: "node",
      framework: "express",
      role: "backend",
      packageManager: "npm",
      scripts: { build: "tsc", start: "node dist/index.js" },
      entrypoints: ["apps/api/src/index.ts"],
      hasDockerfile: false,
      routeCandidates: [
        { method: "GET", path: "/health", kind: "explicit", evidence: ["apps/api/src/index.ts:6"], score: 40 },
      ],
      evidence: ["apps/api/package.json"],
    },
  ],
  dataNeeds: [],
  envRefs: [],
  hardcodedUrls: [],
  monorepoTool: "none",
};

describe("verification path grounding", () => {
  it("warns when healthCheckPath is not in route candidates", () => {
    const plan: DeploymentPlan = {
      goal: "x",
      classification: "deployable",
      services: [
        {
          id: "api",
          type: "node_api",
          provider: "render",
          rootDir: "apps/api",
          install: "npm install",
          build: "npm run build",
          start: "npm run start",
          outputDir: null,
          healthCheckPath: "/nope",
          env: [],
          evidence: [],
        },
      ],
      managed: [],
      wiring: [],
      deployOrder: ["api"],
      questions: [],
      blockers: [],
      verification: [{ serviceId: "api", check: "health_path", target: "/nope" }],
      confidence: 0.95,
    };

    const { issues } = validatePlan(plan, ctx, emptyCapabilities());
    expect(issues.some((i) => i.code === "health_path_ungrounded")).toBe(true);
    expect(issues.some((i) => i.code === "verification_path_ungrounded")).toBe(true);
  });

  it("needs_input when verification has no path", () => {
    const plan: DeploymentPlan = {
      goal: "x",
      classification: "deployable",
      services: [
        {
          id: "api",
          type: "node_api",
          provider: "render",
          rootDir: "apps/api",
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
      questions: [],
      blockers: [],
      verification: [{ serviceId: "api", check: "http_2xx" }],
      confidence: 0.95,
    };

    const { plan: validated, issues } = validatePlan(plan, ctx, fullCaps);
    expect(issues.some((i) => i.code === "verification_path_missing")).toBe(true);
    expect(validated.classification).toBe("needs_setup");
  });
});
