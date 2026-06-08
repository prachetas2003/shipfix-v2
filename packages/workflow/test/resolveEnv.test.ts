import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { DeploymentPlan, PlanService } from "@shipfix/contracts";
import { createSecretVault } from "@shipfix/secrets";
import { resolveServiceEnv } from "../src/resolveEnv";

const apiService: PlanService = {
  id: "api",
  type: "node_api",
  provider: "render",
  rootDir: "apps/api",
  install: null,
  build: null,
  start: null,
  outputDir: null,
  healthCheckPath: "/health",
  env: [{ name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" }],
  evidence: [],
};

const webService: PlanService = {
  id: "web",
  type: "frontend_static",
  provider: "vercel",
  rootDir: "apps/web",
  install: null,
  build: null,
  start: null,
  outputDir: "dist",
  healthCheckPath: null,
  env: [{ name: "VITE_API_URL", source: "generated_from_service", ref: "api.publicUrl" }],
  evidence: [],
};

const plan: DeploymentPlan = {
  goal: "x",
  classification: "deployable",
  services: [apiService, webService],
  managed: [{ id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" }],
  wiring: [{ fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: "VITE_API_URL" }],
  deployOrder: ["db", "api", "web"],
  questions: [],
  blockers: [],
  verification: [],
  confidence: 1,
};

describe("resolveServiceEnv", () => {
  it("resolves DATABASE_URL from a sealed managed resource", async () => {
    const vault = createSecretVault(randomBytes(32));
    const secret = "postgres://u:p@ep.neon.tech/db?sslmode=require";
    const sealed = await vault.seal(secret);

    const { env, issues } = await resolveServiceEnv(
      apiService,
      plan,
      [
        {
          serviceId: "db",
          status: "live",
          url: null,
          exposesEnv: "DATABASE_URL",
          encBlob: sealed.encBlob,
          encIv: sealed.encIv,
          encDek: sealed.encDek,
        },
      ],
      vault,
    );

    expect(issues).toHaveLength(0);
    expect(env.DATABASE_URL).toBe(secret);
  });

  it("reports missing managed resource without exposing secrets", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(apiService, plan, [], vault);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(issues[0]?.code).toBe("missing_managed");
  });

  it("resolves generated_from_service publicUrl from deployed service row", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(
      webService,
      plan,
      [
        {
          serviceId: "api",
          status: "live",
          url: "https://api.onrender.com",
          exposesEnv: null,
          encBlob: null,
          encIv: null,
          encDek: null,
        },
      ],
      vault,
    );
    expect(issues).toHaveLength(0);
    expect(env.VITE_API_URL).toBe("https://api.onrender.com");
  });

  it("resolves generated_from_service origin field", async () => {
    const vault = createSecretVault(randomBytes(32));
    const svc: PlanService = {
      ...webService,
      env: [{ name: "API_ORIGIN", source: "generated_from_service", ref: "api.origin" }],
    };
    const { env, issues } = await resolveServiceEnv(
      svc,
      plan,
      [
        {
          serviceId: "api",
          status: "live",
          url: "https://api.onrender.com/health",
          exposesEnv: null,
          encBlob: null,
          encIv: null,
          encDek: null,
        },
      ],
      vault,
    );
    expect(issues).toHaveLength(0);
    expect(env.API_ORIGIN).toBe("https://api.onrender.com");
  });

  it("reports missing upstream service when not yet deployed", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { issues } = await resolveServiceEnv(webService, plan, [], vault);
    expect(issues[0]?.code).toBe("missing_service");
  });
});
