import { describe, it, expect } from "vitest";
import { buildDeployFailureGuidance, buildRepoFixGuidance } from "../src/deployFailureGuidance";

const service = {
  id: "api",
  type: "node_api" as const,
  rootDir: "apps/api",
  install: "npm ci",
  build: "npm run build",
  start: "npm start",
  healthCheckPath: "/health",
};

const web = {
  id: "web",
  type: "frontend_static" as const,
  rootDir: "apps/web",
  install: "npm install",
  build: "npm run build",
  start: null,
  healthCheckPath: null,
};

describe("buildDeployFailureGuidance", () => {
  it("routes permission 403 to update_credentials — no Cursor prompt", () => {
    const g = buildDeployFailureGuidance({
      repoFullName: "acme/app",
      service: web,
      provider: "vercel",
      failureKind: "deploy_failed", // even if mis-tagged
      errorSummary: "Vercel API HTTP 403: You don't have permission to create the project.",
    });
    expect(g.action).toBe("update_credentials");
    expect(g.showCursorPrompt).toBe(false);
    expect(g.fixPrompt).toBeUndefined();
    expect(g.whatHappened).toMatch(/403|permission/i);
    expect(g.whatYouShouldDo.join(" ")).toMatch(/not a bug in your application code/i);
  });

  it("routes setup_blocker to credentials/account — no Cursor prompt", () => {
    const g = buildDeployFailureGuidance({
      repoFullName: "acme/app",
      service: web,
      provider: "vercel",
      failureKind: "setup_blocker",
      errorSummary: "Vercel GitHub connection required: add a Login Connection",
    });
    expect(g.action).toBe("fix_account_setup");
    expect(g.showCursorPrompt).toBe(false);
  });

  it("routes build failures to fix_repo_code with a Cursor prompt", () => {
    const g = buildDeployFailureGuidance({
      repoFullName: "acme/app",
      service,
      provider: "render",
      failureKind: "build_failed",
      errorSummary: "tsc error TS2304: Cannot find name 'foo'.",
    });
    expect(g.action).toBe("fix_repo_code");
    expect(g.showCursorPrompt).toBe(true);
    expect(g.fixPrompt).toContain("TS2304");
    expect(g.fixPrompt).toContain("not a ShipFix credential issue");
  });

  it("does not claim generic deploy_failed is a repo bug", () => {
    const g = buildDeployFailureGuidance({
      repoFullName: "acme/app",
      service: web,
      provider: "vercel",
      failureKind: "deploy_failed",
      errorSummary: "Vercel API HTTP 500: upstream error",
    });
    expect(g.action).toBe("inspect_error");
    expect(g.showCursorPrompt).toBe(false);
    expect(g.whatYouShouldDo.join(" ")).toMatch(/Read the error/i);
  });

  it("routes provider_limit without a Cursor prompt", () => {
    const g = buildDeployFailureGuidance({
      repoFullName: "acme/app",
      service: web,
      provider: "vercel",
      failureKind: "provider_limit",
      errorSummary: "A Git Repository cannot be connected to more than 10 Projects.",
    });
    expect(g.action).toBe("resolve_provider_limit");
    expect(g.showCursorPrompt).toBe(false);
  });
});

describe("buildRepoFixGuidance (legacy)", () => {
  it("returns null for credential failures", () => {
    expect(
      buildRepoFixGuidance({
        repoFullName: "acme/app",
        service: web,
        provider: "vercel",
        failureKind: "setup_blocker",
        errorSummary: "permission denied",
      }),
    ).toBeNull();
  });

  it("returns a prompt for build failures", () => {
    const g = buildRepoFixGuidance({
      repoFullName: "acme/app",
      service,
      provider: "render",
      failureKind: "build_failed",
      errorSummary: "boom",
    });
    expect(g).not.toBeNull();
    expect(g!.fixPrompt).toContain("acme/app");
  });
});
