import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";
import { createFakeGateway } from "@shipfix/llm/testing";
import { capabilities, emptyCapabilities, validatePlan } from "@shipfix/validator";
import { generatePlan } from "../src/index";
import { buildUserPrompt } from "../src/prompt";

const ctx: RepoContext = {
  repoFullName: "acme/app",
  commitSha: "abc123",
  fileTree: [
    "package.json",
    "pnpm-workspace.yaml",
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "apps/api/package.json",
    "apps/api/src/index.ts",
  ],
  services: [
    {
      rootDir: "apps/web",
      language: "node",
      framework: "vite",
      role: "frontend",
      packageManager: "npm",
      scripts: { build: "vite build", dev: "vite" },
      entrypoints: [],
      hasDockerfile: false,
      evidence: ["apps/web/package.json"],
    },
    {
      rootDir: "apps/api",
      language: "node",
      framework: "express",
      role: "backend",
      packageManager: "npm",
      scripts: { build: "tsc", start: "node dist/index.js" },
      entrypoints: ["apps/api/src/index.ts"],
      routeCandidates: [{ method: "GET", path: "/health", kind: "explicit", evidence: ["apps/api/src/index.ts"], score: 40 }],
      hasDockerfile: false,
      evidence: ["apps/api/package.json"],
    },
  ],
  dataNeeds: [
    { kind: "postgres", detectedFrom: "dep", migrationTool: "none", evidence: ["apps/api/package.json"] },
  ],
  envRefs: [
    { name: "DATABASE_URL", service: "apps/api", required: true },
    { name: "VITE_API_URL", service: "apps/web", required: true },
  ],
  hardcodedUrls: [],
  monorepoTool: "pnpm_workspace",
};

/** A grounded, schema-valid plan for `ctx` (vite + express + postgres). */
const groundedPlan: DeploymentPlan = {
  goal: "Deploy the Vite frontend, Express API, and provision Postgres.",
  classification: "deployable",
  services: [
    {
      id: "web",
      type: "frontend_static",
      provider: "vercel",
      rootDir: "apps/web",
      install: "npm install",
      build: "npm run build",
      start: null,
      outputDir: "dist",
      healthCheckPath: null,
      env: [{ name: "VITE_API_URL", source: "generated_from_service", ref: "api.publicUrl" }],
      evidence: ["apps/web/package.json"],
    },
    {
      id: "api",
      type: "node_api",
      provider: "render",
      rootDir: "apps/api",
      install: "npm install",
      build: "npm run build",
      start: "npm run start",
      outputDir: null,
      healthCheckPath: "/health",
      env: [{ name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" }],
      evidence: ["apps/api/package.json"],
    },
  ],
  managed: [
    { id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" },
  ],
  wiring: [
    { fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: "VITE_API_URL" },
    { fromServiceId: "db", fromField: "connectionUrl", toServiceId: "api", toEnvName: "DATABASE_URL" },
  ],
  deployOrder: ["db", "api", "web"],
  questions: [],
  blockers: [],
  verification: [
    { serviceId: "api", check: "health_path", target: "/health" },
    { serviceId: "web", check: "frontend_loads" },
  ],
  confidence: 0.8,
};

const json = JSON.stringify(groundedPlan);

describe("generatePlan", () => {
  it("parses a clean JSON response into a DeploymentPlan", async () => {
    const fake = createFakeGateway(json);
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.usedFallback).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.plan.services.map((s) => s.id)).toEqual(["web", "api"]);
  });

  it("parses a response wrapped in ```json fences", async () => {
    const fake = createFakeGateway("```json\n" + json + "\n```");
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.usedFallback).toBe(false);
    expect(r.plan.classification).toBe("deployable");
  });

  it("parses JSON embedded in prose", async () => {
    const fake = createFakeGateway("Here is the plan you asked for:\n" + json + "\nLet me know!");
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.usedFallback).toBe(false);
    expect(r.plan.managed[0].id).toBe("db");
  });

  it("sends RepoContext evidence in the user prompt (and never a secret)", async () => {
    const fake = createFakeGateway(json);
    await generatePlan(ctx, fake.gateway);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].user).toContain("apps/api");
    expect(fake.calls[0].user).toContain("DATABASE_URL");
    expect(fake.calls[0].system).toContain("DEPLOYMENT OPERATOR");
  });

  it("repairs invalid-then-valid output in a second attempt", async () => {
    const fake = createFakeGateway(["{ this is not valid json", json]);
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.attempts).toBe(2);
    expect(r.usedFallback).toBe(false);
    expect(r.plan.classification).toBe("deployable");
    // Second call must be a repair prompt.
    expect(fake.calls[1].user).toContain("not valid against the DeploymentPlan schema");
  });

  it("falls back to an honest diagnose_only plan when output never conforms", async () => {
    const fake = createFakeGateway("totally not json, sorry");
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.usedFallback).toBe(true);
    expect(r.plan.classification).toBe("diagnose_only");
    expect(r.plan.services).toHaveLength(0);
    expect(r.plan.blockers[0].title).toContain("could not produce a valid plan");
    expect(r.plan.confidence).toBe(0);
  });

  it("rejects a schema-valid plan that omits required fields (forces repair)", async () => {
    const bad = JSON.stringify({ goal: "x", classification: "deployable" });
    const fake = createFakeGateway([bad, json]);
    const r = await generatePlan(ctx, fake.gateway);
    expect(r.attempts).toBe(2);
    expect(r.usedFallback).toBe(false);
  });
});

describe("buildUserPrompt alpha safety", () => {
  it("excludes .env files and lockfiles from prompt fileTree", () => {
    const prompt = buildUserPrompt({
      ...ctx,
      fileTree: [".env", ".env.local", "apps/web/package-lock.json", "apps/web/src/main.tsx"],
    });
    expect(prompt).not.toContain('"fileTree": [\n    ".env"');
    expect(prompt).not.toContain('".env"');
    expect(prompt).not.toContain('"package-lock.json"');
    expect(prompt).toContain("apps/web/src/main.tsx");
    expect(prompt).toContain("excludedSensitiveOrLowSignalFileCount");
  });

  it("caps prompt size with an explicit alpha truncation marker", () => {
    const manyFiles = Array.from({ length: 5000 }, (_, i) => `apps/web/src/${"nested/".repeat(200)}file-${i}.tsx`);
    const prompt = buildUserPrompt({ ...ctx, fileTree: manyFiles });
    expect(prompt.length).toBeLessThanOrEqual(121_000);
    expect(prompt).toContain("TRUNCATED_FOR_ALPHA_PROMPT_LIMIT");
  });
});

describe("planner -> validator pipeline (isolated)", () => {
  it("a grounded plan stays deployable with full capabilities", async () => {
    const fake = createFakeGateway(json);
    const { plan } = await generatePlan(ctx, fake.gateway);
    const caps = capabilities(
      {
        vercel: ["frontend_static", "frontend_ssr"],
        render: ["node_api", "python_api", "worker", "docker_service"],
      },
      ["neon", "upstash", "supabase"],
    );
    const result = validatePlan(plan, ctx, caps);
    expect(result.issues).toHaveLength(0);
    expect(result.plan.classification).toBe("deployable");
  });

  it("the validator downgrades the same plan to needs_setup with no connected providers", async () => {
    const fake = createFakeGateway(json);
    const { plan } = await generatePlan(ctx, fake.gateway);
    const result = validatePlan(plan, ctx, emptyCapabilities());
    expect(result.plan.classification).toBe("needs_setup");
    expect(result.issues.some((i) => i.code === "provider_not_connected")).toBe(true);
  });
});
