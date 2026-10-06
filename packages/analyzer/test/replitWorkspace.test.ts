import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo, createLocalFsRepoSource } from "../src/index";

/**
 * Replit Agent's pnpm-workspace template: artifacts/api-server (Express) +
 * artifacts/<app> (Vite) + artifacts/mockup-sandbox (design canvas) + lib/*
 * internal packages (db, zod schemas) + scripts/. Only the API and the app
 * are deployable; everything else must not block the plan or the user.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/replit-pnpm-workspace", import.meta.url));
const FULL_CAPS = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] },
  ["neon"],
);

function analyze() {
  return analyzeRepo(createLocalFsRepoSource(FIXTURE), {
    repoFullName: "fixtures/replit-pnpm-workspace",
    commitSha: "0".repeat(40),
  });
}

describe("Replit pnpm-workspace template", () => {
  it("detects only the API and the app as services", async () => {
    const ctx = await analyze();
    expect(ctx.services.map((s) => `${s.rootDir}=${s.framework}`).sort()).toEqual([
      "artifacts/api-server=express",
      "artifacts/shop=vite",
    ]);
    expect(ctx.dataNeeds).toEqual([expect.objectContaining({ kind: "postgres", migrationTool: "drizzle" })]);
  });

  it("attributes library env refs to the importing service and ignores tests, scripts and platform vars", async () => {
    const ctx = await analyze();
    const refs = ctx.envRefs.map((r) => `${r.service}:${r.name}:${r.required ? "req" : "opt"}`).sort();
    expect(refs).toEqual([
      "artifacts/api-server:DATABASE_URL:req",
      "artifacts/api-server:LOG_LEVEL:opt",
      "artifacts/api-server:PORT:req",
      "artifacts/shop:BASE_PATH:req",
      "artifacts/shop:PORT:req",
    ]);
    expect(ctx.hardcodedUrls).toEqual([]);
  });

  it("plans a deployable app without asking the user anything", async () => {
    const ctx = await analyze();
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan).not.toBeNull();
    expect(plan?.questions).toEqual([]);

    const web = plan?.services.find((s) => s.id === "web");
    expect(web?.rootDir).toBe("artifacts/shop");
    expect(web?.env).toEqual(
      expect.arrayContaining([
        { name: "PORT", source: "literal", value: "3000" },
        { name: "BASE_PATH", source: "literal", value: "/" },
      ]),
    );
    const api = plan?.services.find((s) => s.id === "api");
    expect(api?.healthCheckPath).toBe("/api/healthz");
    expect(api?.env).toContainEqual({ name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" });
    expect(api?.env.some((e) => e.name === "LOG_LEVEL")).toBe(false);

    const result = validatePlan(plan!, ctx, FULL_CAPS);
    expect(result.issues).toEqual([]);
    expect(result.plan.classification).toBe("deployable");
  });
});
