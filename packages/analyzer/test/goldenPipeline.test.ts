import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo, createLocalFsRepoSource } from "../src/index";

/**
 * Golden-repo regression net.
 *
 * Fixtures cover the supported deterministic topologies:
 * - `golden-fullstack`: pnpm workspace Vite web + Express API + Postgres (`pg`)
 * - `golden-next`: standalone Next.js App Router + Postgres
 * - `golden-next-api`: pnpm workspace Next.js web + Express API + Postgres
 *
 * Each test runs analyze -> deterministic synthesis -> validation offline and
 * pins the plan facts ShipFix relies on to deploy. No LLM, no network.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const FIXTURE = path.join(FIXTURES, "golden-fullstack");
const NEXT_FIXTURE = path.join(FIXTURES, "golden-next");
const NEXT_API_FIXTURE = path.join(FIXTURES, "golden-next-api");

const FULL_CAPS = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] },
  ["neon"],
);

async function analyzeGolden() {
  const source = createLocalFsRepoSource(FIXTURE);
  return analyzeRepo(source, {
    repoFullName: "fixtures/golden-fullstack",
    commitSha: "0".repeat(40),
  });
}

async function analyzeGoldenNext() {
  const source = createLocalFsRepoSource(NEXT_FIXTURE);
  return analyzeRepo(source, {
    repoFullName: "fixtures/golden-next",
    commitSha: "0".repeat(40),
  });
}

async function analyzeGoldenNextApi() {
  const source = createLocalFsRepoSource(NEXT_API_FIXTURE);
  return analyzeRepo(source, {
    repoFullName: "fixtures/golden-next-api",
    commitSha: "0".repeat(40),
  });
}

describe("golden full-stack repo: analyze -> synthesize -> validate", () => {
  it("analyzer detects the exact expected shape", async () => {
    const ctx = await analyzeGolden();

    expect(ctx.monorepoTool).toBe("pnpm_workspace");
    const roots = ctx.services.map((s) => s.rootDir).sort();
    expect(roots).toEqual(["apps/api", "apps/web"]);

    const web = ctx.services.find((s) => s.rootDir === "apps/web");
    expect(web?.framework).toBe("vite");
    expect(web?.role).toBe("frontend");
    expect(web?.scripts.build).toBe("vite build");

    const api = ctx.services.find((s) => s.rootDir === "apps/api");
    expect(api?.framework).toBe("express");
    expect(api?.role).toBe("backend");
    expect(api?.scripts.start).toBe("node src/index.js");
    expect(api?.routeCandidates.some((r) => r.path === "/health" && r.method === "GET")).toBe(true);

    expect(ctx.dataNeeds).toEqual([
      expect.objectContaining({ kind: "postgres", migrationTool: "none" }),
    ]);
    const refNames = ctx.envRefs.map((r) => `${r.service}:${r.name}`).sort();
    expect(refNames).toEqual(["apps/api:DATABASE_URL", "apps/api:PORT", "apps/web:VITE_API_URL"]);
    expect(ctx.hardcodedUrls).toHaveLength(0);
  });

  it("synthesizes a deterministic GREEN plan with exact commands and wiring", async () => {
    const ctx = await analyzeGolden();
    const plan = synthesizeDeterministicPlan(ctx);

    expect(plan).not.toBeNull();
    expect(plan?.planSource).toBe("deterministic");
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "api", "web"]);

    const api = plan?.services.find((s) => s.id === "api");
    expect(api).toMatchObject({
      type: "node_api",
      provider: "render",
      rootDir: "apps/api",
      install: "pnpm install",
      start: "pnpm run start",
      healthCheckPath: "/health",
    });
    expect(api?.env).toContainEqual({ name: "PORT", source: "provider_injected" });
    expect(api?.env).toContainEqual({
      name: "DATABASE_URL",
      source: "generated_from_managed",
      ref: "db.connectionUrl",
    });

    const web = plan?.services.find((s) => s.id === "web");
    expect(web).toMatchObject({
      type: "frontend_static",
      provider: "vercel",
      rootDir: "apps/web",
      install: "pnpm install",
      build: "pnpm run build",
      outputDir: "dist",
    });
    expect(web?.env).toContainEqual({
      name: "VITE_API_URL",
      source: "generated_from_service",
      ref: "api.publicUrl",
    });

    expect(plan?.managed).toEqual([
      { id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" },
    ]);
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "db",
      fromField: "connectionUrl",
      toServiceId: "api",
      toEnvName: "DATABASE_URL",
    });
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "api",
      fromField: "publicUrl",
      toServiceId: "web",
      toEnvName: "VITE_API_URL",
    });
    expect(plan?.verification).toContainEqual({ serviceId: "api", check: "health_path", target: "/health" });
    expect(plan?.verification).toContainEqual({ serviceId: "web", check: "frontend_loads" });
    expect(plan?.verification).toContainEqual({ serviceId: "api", check: "cors_from", target: "web" });
  });

  it("stays deployable through the validator with full capabilities", async () => {
    const ctx = await analyzeGolden();
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();

    const result = validatePlan(plan!, ctx, FULL_CAPS);
    expect(result.issues).toEqual([]);
    expect(result.plan.classification).toBe("deployable");

    // Health fallback candidates persisted for the verifier.
    const api = result.plan.services.find((s) => s.id === "api");
    expect(api?.healthCandidates?.[0]).toBe("/health");
    expect(api?.healthCandidates).toContain("/todos");
  });

  it("downgrades honestly (never deploys blind) when no providers are connected", async () => {
    const ctx = await analyzeGolden();
    const plan = synthesizeDeterministicPlan(ctx);
    const result = validatePlan(plan!, ctx, capabilities({}, []));
    expect(result.plan.classification).toBe("needs_setup");
    expect(result.issues.some((i) => i.code === "provider_not_connected")).toBe(true);
  });
});

describe("golden Next.js repo: analyze -> synthesize -> validate", () => {
  it("analyzer detects a standalone Next app with file-based API routes", async () => {
    const ctx = await analyzeGoldenNext();

    expect(ctx.services).toHaveLength(1);
    const app = ctx.services[0];
    expect(app.rootDir).toBe("");
    expect(app.framework).toBe("next");
    expect(app.role).toBe("fullstack");
    expect(app.scripts.build).toBe("next build");
    expect(app.routeCandidates.some((r) => r.path === "/api/health")).toBe(true);
    expect(app.routeCandidates.some((r) => r.path === "/api/todos")).toBe(true);

    expect(ctx.dataNeeds).toEqual([
      expect.objectContaining({ kind: "postgres", migrationTool: "none" }),
    ]);
    expect(ctx.envRefs).toEqual([{ name: "DATABASE_URL", service: "", required: true }]);
  });

  it("synthesizes a deterministic frontend_ssr plan with DB wiring into Vercel", async () => {
    const ctx = await analyzeGoldenNext();
    const plan = synthesizeDeterministicPlan(ctx);

    expect(plan).not.toBeNull();
    expect(plan?.planSource).toBe("deterministic");
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "web"]);

    const web = plan?.services.find((s) => s.id === "web");
    expect(web).toMatchObject({
      type: "frontend_ssr",
      provider: "vercel",
      rootDir: "",
      install: "npm install",
      build: "npm run build",
      outputDir: null,
      healthCheckPath: "/api/health",
    });
    expect(web?.env).toContainEqual({
      name: "DATABASE_URL",
      source: "generated_from_managed",
      ref: "db.connectionUrl",
    });
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "db",
      fromField: "connectionUrl",
      toServiceId: "web",
      toEnvName: "DATABASE_URL",
    });
    expect(plan?.verification).toContainEqual({ serviceId: "web", check: "frontend_loads" });
    expect(plan?.verification).toContainEqual({
      serviceId: "web",
      check: "health_path",
      target: "/api/health",
    });
  });

  it("stays deployable through the validator with full capabilities", async () => {
    const ctx = await analyzeGoldenNext();
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();

    const result = validatePlan(plan!, ctx, FULL_CAPS);
    expect(result.issues).toEqual([]);
    expect(result.plan.classification).toBe("deployable");
  });
});

describe("golden Next+API monorepo: analyze -> synthesize -> validate", () => {
  it("analyzer detects apps/web next + apps/api express", async () => {
    const ctx = await analyzeGoldenNextApi();

    expect(ctx.monorepoTool).toBe("pnpm_workspace");
    const roots = ctx.services.map((s) => s.rootDir).sort();
    expect(roots).toEqual(["apps/api", "apps/web"]);

    const web = ctx.services.find((s) => s.rootDir === "apps/web");
    expect(web?.framework).toBe("next");
    expect(web?.role).toBe("fullstack");
    expect(web?.scripts.build).toBe("next build");

    const api = ctx.services.find((s) => s.rootDir === "apps/api");
    expect(api?.framework).toBe("express");
    expect(api?.role).toBe("backend");
    expect(api?.scripts.start).toBe("node src/index.js");
    expect(api?.routeCandidates.some((r) => r.path === "/health" && r.method === "GET")).toBe(true);

    expect(ctx.dataNeeds).toEqual([
      expect.objectContaining({ kind: "postgres", migrationTool: "none" }),
    ]);
    const refNames = ctx.envRefs.map((r) => `${r.service}:${r.name}`).sort();
    expect(refNames).toEqual([
      "apps/api:DATABASE_URL",
      "apps/api:PORT",
      "apps/web:NEXT_PUBLIC_API_URL",
    ]);
    expect(ctx.hardcodedUrls).toHaveLength(0);
  });

  it("synthesizes deterministic frontend_ssr + node_api + neon", async () => {
    const ctx = await analyzeGoldenNextApi();
    const plan = synthesizeDeterministicPlan(ctx);

    expect(plan).not.toBeNull();
    expect(plan?.planSource).toBe("deterministic");
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "api", "web"]);

    const api = plan?.services.find((s) => s.id === "api");
    expect(api).toMatchObject({
      type: "node_api",
      provider: "render",
      rootDir: "apps/api",
      install: "pnpm install",
      start: "pnpm run start",
      healthCheckPath: "/health",
    });
    expect(api?.env).toContainEqual({ name: "PORT", source: "provider_injected" });
    expect(api?.env).toContainEqual({
      name: "DATABASE_URL",
      source: "generated_from_managed",
      ref: "db.connectionUrl",
    });

    const web = plan?.services.find((s) => s.id === "web");
    expect(web).toMatchObject({
      type: "frontend_ssr",
      provider: "vercel",
      rootDir: "apps/web",
      install: "pnpm install",
      build: "pnpm run build",
      outputDir: null,
    });
    expect(web?.env).toContainEqual({
      name: "NEXT_PUBLIC_API_URL",
      source: "generated_from_service",
      ref: "api.publicUrl",
    });

    expect(plan?.managed).toEqual([
      {
        id: "db",
        kind: "postgres",
        mode: "provision",
        provider: "neon",
        exposesEnv: "DATABASE_URL",
        migration: "none",
      },
    ]);
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "db",
      fromField: "connectionUrl",
      toServiceId: "api",
      toEnvName: "DATABASE_URL",
    });
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "api",
      fromField: "publicUrl",
      toServiceId: "web",
      toEnvName: "NEXT_PUBLIC_API_URL",
    });
    expect(plan?.verification).toContainEqual({
      serviceId: "api",
      check: "health_path",
      target: "/health",
    });
    expect(plan?.verification).toContainEqual({ serviceId: "web", check: "frontend_loads" });
    expect(plan?.verification).toContainEqual({
      serviceId: "api",
      check: "cors_from",
      target: "web",
    });
  });

  it("stays deployable through the validator with full capabilities", async () => {
    const ctx = await analyzeGoldenNextApi();
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();

    const result = validatePlan(plan!, ctx, FULL_CAPS);
    expect(result.issues).toEqual([]);
    expect(result.plan.classification).toBe("deployable");
  });
});
