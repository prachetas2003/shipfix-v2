import { describe, expect, it } from "vitest";
import type { RepoContext, ServiceSignal } from "@shipfix/contracts";
import { DeploymentPlan } from "@shipfix/contracts";
import { createFakeGateway } from "@shipfix/llm/testing";
import { capabilities, validatePlan } from "@shipfix/validator";
import { generatePlan, synthesizeDeterministicPlan } from "../src/index";

function frontendSignal(overrides: Partial<ServiceSignal> = {}): ServiceSignal {
  return {
    rootDir: "web",
    language: "node",
    framework: "vite",
    role: "frontend",
    packageManager: "npm",
    scripts: { dev: "vite", build: "vite build" },
    entrypoints: ["web/src/main.tsx"],
    hasDockerfile: false,
    routeCandidates: [],
    evidence: ["web/package.json"],
    ...overrides,
  };
}

function backendSignal(overrides: Partial<ServiceSignal> = {}): ServiceSignal {
  return {
    rootDir: "server",
    language: "node",
    framework: "express",
    role: "backend",
    packageManager: "npm",
    scripts: { start: "node src/index.js" },
    entrypoints: ["server/src/index.js"],
    hasDockerfile: false,
    routeCandidates: [
      { method: "GET", path: "/health", kind: "explicit", evidence: ["server/src/index.js"], score: 40 },
      { method: "GET", path: "/todos", kind: "explicit", evidence: ["server/src/index.js"], score: 5 },
    ],
    evidence: ["server/package.json"],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    repoFullName: "acme/fullstack",
    commitSha: "0".repeat(40),
    fileTree: ["package.json", "web/package.json", "server/package.json"],
    services: [frontendSignal(), backendSignal()],
    dataNeeds: [{ kind: "postgres", detectedFrom: "dep", migrationTool: "none", evidence: [] }],
    envRefs: [
      { name: "DATABASE_URL", service: "server", required: true },
      { name: "PORT", service: "server", required: true },
      { name: "VITE_API_URL", service: "web", required: true },
    ],
    hardcodedUrls: [],
    monorepoTool: "none",
    ...overrides,
  };
}

describe("synthesizeDeterministicPlan", () => {
  it("builds a schema-valid deployable plan for the full supported slice", () => {
    const plan = synthesizeDeterministicPlan(makeCtx());
    expect(plan).not.toBeNull();
    expect(() => DeploymentPlan.parse(plan)).not.toThrow();
    expect(plan?.planSource).toBe("deterministic");
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "api", "web"]);

    const api = plan?.services.find((s) => s.id === "api");
    expect(api?.provider).toBe("render");
    expect(api?.install).toBe("npm install");
    expect(api?.start).toBe("npm run start");
    expect(api?.healthCheckPath).toBe("/health");
    expect(api?.healthCandidates).toEqual(["/health", "/todos"]);
    expect(api?.env).toContainEqual({ name: "PORT", source: "provider_injected" });
    expect(api?.env).toContainEqual({
      name: "DATABASE_URL",
      source: "generated_from_managed",
      ref: "db.connectionUrl",
    });

    const web = plan?.services.find((s) => s.id === "web");
    expect(web?.provider).toBe("vercel");
    expect(web?.outputDir).toBe("dist");
    expect(web?.env).toContainEqual({
      name: "VITE_API_URL",
      source: "generated_from_service",
      ref: "api.publicUrl",
    });

    expect(plan?.verification).toContainEqual({ serviceId: "api", check: "health_path", target: "/health" });
    expect(plan?.verification).toContainEqual({ serviceId: "web", check: "frontend_loads" });
    expect(plan?.verification).toContainEqual({ serviceId: "api", check: "cors_from", target: "web" });
  });

  it("uses the detected package manager for commands", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({ packageManager: "pnpm" }),
        backendSignal({ packageManager: "pnpm" }),
      ],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "web")?.install).toBe("pnpm install");
    expect(plan?.services.find((s) => s.id === "api")?.start).toBe("pnpm run start");
  });

  it("downgrades to needs_setup when the frontend hardcodes a localhost URL", () => {
    const ctx = makeCtx({
      hardcodedUrls: [{ value: "http://localhost:3001", file: "web/src/api.ts", service: "web" }],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.classification).toBe("needs_setup");
    expect(plan?.blockers.some((b) => b.title.includes("hardcodes"))).toBe(true);
  });

  it("asks for unmappable env vars as user secrets (needs_setup, never invented)", () => {
    const ctx = makeCtx({
      envRefs: [
        ...makeCtx().envRefs,
        { name: "STRIPE_SECRET_KEY", service: "server", required: true },
      ],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.classification).toBe("needs_setup");
    const api = plan?.services.find((s) => s.id === "api");
    expect(api?.env).toContainEqual({ name: "STRIPE_SECRET_KEY", source: "user_secret" });
    expect(plan?.questions.some((q) => q.prompt.includes("STRIPE_SECRET_KEY"))).toBe(true);
  });

  it("wires backend CORS/frontend-origin refs from web.origin (deferred until frontend is live)", () => {
    const ctx = makeCtx({
      envRefs: [...makeCtx().envRefs, { name: "CORS_ORIGIN", service: "server", required: true }],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.classification).toBe("deployable");
    const api = plan?.services.find((s) => s.id === "api");
    expect(api?.env).toContainEqual({
      name: "CORS_ORIGIN",
      source: "generated_from_service",
      ref: "web.origin",
    });
    expect(plan?.wiring).toContainEqual({
      fromServiceId: "web",
      fromField: "origin",
      toServiceId: "api",
      toEnvName: "CORS_ORIGIN",
    });
  });

  it("returns null for non-Next SSR repos (Nuxt fullstack)", () => {
    const ctx = makeCtx({
      services: [frontendSignal({ framework: "nuxt", role: "fullstack" })],
    });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("returns null for Python services", () => {
    const ctx = makeCtx({
      services: [backendSignal({ language: "python", framework: "fastapi" })],
    });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("returns null for non-postgres data needs", () => {
    const ctx = makeCtx({
      dataNeeds: [{ kind: "redis", detectedFrom: "dep", migrationTool: "none", evidence: [] }],
    });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("returns null when the backend has no start script", () => {
    const ctx = makeCtx({ services: [frontendSignal(), backendSignal({ scripts: {} })] });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("builds a frontend_ssr plan for a standalone Next.js app with Postgres", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({
          rootDir: "",
          framework: "next",
          role: "fullstack",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          routeCandidates: [
            { method: "GET", path: "/api/health", kind: "inferred", evidence: ["app/api/health/route.ts"], score: 38 },
            { method: "GET", path: "/api/todos", kind: "inferred", evidence: ["app/api/todos/route.ts"], score: 3 },
          ],
          evidence: ["package.json"],
        }),
      ],
      envRefs: [{ name: "DATABASE_URL", service: "", required: true }],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();
    expect(() => DeploymentPlan.parse(plan)).not.toThrow();
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "web"]);

    const web = plan?.services.find((s) => s.id === "web");
    expect(web?.type).toBe("frontend_ssr");
    expect(web?.provider).toBe("vercel");
    expect(web?.outputDir).toBeNull();
    expect(web?.healthCheckPath).toBe("/api/health");
    expect(web?.env).toContainEqual({
      name: "DATABASE_URL",
      source: "generated_from_managed",
      ref: "db.connectionUrl",
    });
    expect(plan?.verification).toContainEqual({ serviceId: "web", check: "frontend_loads" });
    expect(plan?.verification).toContainEqual({
      serviceId: "web",
      check: "health_path",
      target: "/api/health",
    });
  });

  it("does not pin a Next health path to a non-health API route", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({
          rootDir: "",
          framework: "next",
          role: "fullstack",
          scripts: { build: "next build" },
          routeCandidates: [
            { method: "GET", path: "/api/todos", kind: "inferred", evidence: ["app/api/todos/route.ts"], score: 3 },
          ],
        }),
      ],
      dataNeeds: [],
      envRefs: [],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    const web = plan?.services.find((s) => s.id === "web");
    expect(web?.healthCheckPath).toBeNull();
    // Verification rests on frontend_loads alone — still deployable.
    expect(plan?.classification).toBe("deployable");
    expect(plan?.verification).toEqual([{ serviceId: "web", check: "frontend_loads" }]);
  });

  it("builds a deterministic Next+API plan (primary topology)", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({
          rootDir: "apps/web",
          framework: "next",
          role: "fullstack",
          packageManager: "pnpm",
          scripts: { build: "next build" },
          routeCandidates: [],
          evidence: ["apps/web/package.json"],
        }),
        backendSignal({
          rootDir: "apps/api",
          packageManager: "pnpm",
          evidence: ["apps/api/package.json"],
        }),
      ],
      envRefs: [
        { name: "DATABASE_URL", service: "apps/api", required: true },
        { name: "PORT", service: "apps/api", required: true },
        { name: "NEXT_PUBLIC_API_URL", service: "apps/web", required: true },
      ],
      monorepoTool: "pnpm_workspace",
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();
    expect(() => DeploymentPlan.parse(plan)).not.toThrow();
    expect(plan?.planSource).toBe("deterministic");
    expect(plan?.classification).toBe("deployable");
    expect(plan?.deployOrder).toEqual(["db", "api", "web"]);

    const web = plan?.services.find((s) => s.id === "web");
    expect(web?.type).toBe("frontend_ssr");
    expect(web?.provider).toBe("vercel");
    expect(web?.rootDir).toBe("apps/web");
    expect(web?.env).toContainEqual({
      name: "NEXT_PUBLIC_API_URL",
      source: "generated_from_service",
      ref: "api.publicUrl",
    });

    const api = plan?.services.find((s) => s.id === "api");
    expect(api?.type).toBe("node_api");
    expect(api?.rootDir).toBe("apps/api");
    expect(plan?.verification).toContainEqual({
      serviceId: "api",
      check: "cors_from",
      target: "web",
    });
  });

  it("returns null for a Next app alongside a separate Vite frontend (ambiguous)", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({ rootDir: "apps/web", framework: "next", role: "fullstack", scripts: { build: "next build" } }),
        frontendSignal({ rootDir: "apps/spa", framework: "vite", role: "frontend", scripts: { build: "vite build" } }),
      ],
      dataNeeds: [],
      envRefs: [],
    });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("returns null for a Next app without a build script", () => {
    const ctx = makeCtx({
      services: [frontendSignal({ rootDir: "", framework: "next", role: "fullstack", scripts: {} })],
      dataNeeds: [],
      envRefs: [],
    });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("keeps Prisma migration plans deployable (migrations run at deploy time)", () => {
    const ctx = makeCtx({
      dataNeeds: [{ kind: "postgres", detectedFrom: "prisma", migrationTool: "prisma", evidence: [] }],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.classification).toBe("deployable");
    expect(plan?.managed[0]?.migration).toBe("prisma");
  });
});

describe("generatePlan deterministic-first", () => {
  it("plans slice repos without any LLM call", async () => {
    const fake = createFakeGateway("this would not parse");
    const r = await generatePlan(makeCtx(), fake.gateway);
    expect(r.planSource).toBe("deterministic");
    expect(r.attempts).toBe(0);
    expect(r.usedFallback).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(r.model).toBe("deterministic");
  });

  it("falls through to the LLM for out-of-slice repos", async () => {
    const outOfSlice = makeCtx({
      services: [backendSignal({ language: "python", framework: "fastapi" })],
    });
    const fake = createFakeGateway("not json at all");
    const r = await generatePlan(outOfSlice, fake.gateway);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(r.planSource).toBe("llm_fallback");
    expect(r.plan.classification).toBe("diagnose_only");
  });

  it("synthesized plan passes the validator as deployable with full capabilities", () => {
    const ctx = makeCtx();
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();
    const caps = capabilities(
      { vercel: ["frontend_static"], render: ["node_api"] },
      ["neon"],
    );
    const result = validatePlan(plan!, ctx, caps);
    expect(result.issues).toHaveLength(0);
    expect(result.plan.classification).toBe("deployable");
  });

  it("synthesized Next.js plan passes the validator as deployable", () => {
    const ctx = makeCtx({
      services: [
        frontendSignal({
          rootDir: "",
          framework: "next",
          role: "fullstack",
          scripts: { build: "next build" },
          routeCandidates: [
            { method: "GET", path: "/api/health", kind: "inferred", evidence: ["app/api/health/route.ts"], score: 38 },
          ],
          evidence: ["package.json"],
        }),
      ],
      fileTree: ["package.json", "app/api/health/route.ts"],
      envRefs: [{ name: "DATABASE_URL", service: "", required: true }],
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();
    const caps = capabilities(
      { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] },
      ["neon"],
    );
    const result = validatePlan(plan!, ctx, caps);
    expect(result.issues).toHaveLength(0);
    expect(result.plan.classification).toBe("deployable");
  });
});
