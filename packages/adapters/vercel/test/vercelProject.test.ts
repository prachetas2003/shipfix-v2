import { describe, expect, it } from "vitest";
import type { DeployInput } from "@shipfix/adapter-core";
import type { PlanService } from "@shipfix/contracts";
import { buildProjectBody, buildProjectPatch, frameworkPreset } from "../src/vercelProject";

function input(service: Partial<PlanService>): DeployInput {
  return {
    service: {
      id: "web",
      type: "frontend_static",
      provider: "vercel",
      rootDir: "",
      install: "npm install",
      build: "npm run build",
      start: null,
      outputDir: "dist",
      healthCheckPath: null,
      env: [],
      evidence: [],
      ...service,
    },
    repo: { fullName: "acme/app", branch: "main", commitSha: "abc123" },
    rootDir: service.rootDir ?? "",
    env: {},
    credentials: { provider: "vercel", values: { apiToken: "t" } },
  };
}

describe("frameworkPreset", () => {
  it("uses the vite preset for static frontends", () => {
    expect(frameworkPreset(input({ type: "frontend_static" }))).toBe("vite");
  });

  it("uses the nextjs preset for SSR frontends", () => {
    expect(frameworkPreset(input({ type: "frontend_ssr" }))).toBe("nextjs");
  });
});

describe("buildProjectBody / buildProjectPatch", () => {
  it("keeps outputDirectory for static frontends", () => {
    const body = buildProjectBody(input({ type: "frontend_static", outputDir: "dist" }), "p");
    expect(body.framework).toBe("vite");
    expect(body.outputDirectory).toBe("dist");
  });

  it("never overrides outputDirectory for Next.js (Vercel manages it)", () => {
    const i = input({ type: "frontend_ssr", outputDir: ".next" });
    expect(buildProjectBody(i, "p").outputDirectory).toBeUndefined();
    expect(buildProjectBody(i, "p").framework).toBe("nextjs");
    expect(buildProjectPatch(i).outputDirectory).toBeUndefined();
    expect(buildProjectPatch(i).framework).toBe("nextjs");
  });
});
