import { describe, it, expect } from "vitest";
import { buildRepoFixGuidance } from "../src/brokenRepoGuidance";

const service = {
  id: "api",
  type: "node_api" as const,
  rootDir: "apps/api",
  install: "npm ci",
  build: "npm run build",
  start: "npm start",
  healthCheckPath: "/health",
};

describe("buildRepoFixGuidance (compat)", () => {
  it("classifies a build failure as the build stage with a copy-pasteable prompt", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "render",
      failureKind: "build_failed",
      errorSummary: "tsc error TS2304: Cannot find name 'foo'.",
    });
    expect(g).not.toBeNull();
    expect(g!.stage).toBe("build");
    expect(g!.checklist.length).toBeGreaterThan(0);
    expect(g!.fixPrompt).toContain("Failing stage: build");
    expect(g!.fixPrompt).toContain("acme/app");
    expect(g!.fixPrompt).toContain("apps/api");
    expect(g!.fixPrompt).toContain("npm run build");
    expect(g!.fixPrompt).toContain("TS2304");
  });

  it("returns null for timeouts (not a Cursor code-fix by default)", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "render",
      failureKind: "timeout",
      errorSummary: "timed out after 600000ms",
    });
    expect(g).toBeNull();
  });

  it("returns null for provider setup blockers (not a repo bug)", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "vercel",
      failureKind: "setup_blocker",
      errorSummary: "Vercel git deployment requires a linked GitHub repoId",
    });
    expect(g).toBeNull();
  });

  it("returns null for provider project limit failures (not a repo bug)", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "vercel",
      failureKind: "provider_limit",
      errorSummary:
        "Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects.",
    });
    expect(g).toBeNull();
  });

  it("returns null for duplicate Vercel env var conflicts (not a repo bug)", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service: { ...service, id: "web", type: "frontend_static" },
      provider: "vercel",
      failureKind: "provider_env_conflict",
      errorSummary: "Vercel env var conflict for VITE_API_URL",
    });
    expect(g).toBeNull();
  });

  it("never instructs ShipFix to edit the repo (operator, not fixer)", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "render",
      failureKind: "build_failed",
      errorSummary: "boom",
    });
    expect(g!.checklist.join(" ")).toMatch(/retry Deploy|Fix the code/i);
  });
});
