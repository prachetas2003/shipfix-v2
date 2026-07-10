import { describe, it, expect } from "vitest";
import type { DeploymentPlan } from "@shipfix/contracts";
import {
  diagnosisFromVerifyOutcome,
  diagnosisForMigrationFailure,
  diagnosisForEnvUnresolved,
} from "../src/diagnosis";
import type { PlanVerifyOutcome } from "../src/verify";

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
      healthCheckPath: "/health",
      env: [],
      evidence: [],
    },
    {
      id: "web",
      type: "frontend_ssr",
      provider: "vercel",
      rootDir: "apps/web",
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
  deployOrder: ["api", "web"],
  questions: [],
  blockers: [],
  verification: [
    { serviceId: "api", check: "cors_from", target: "web" },
    { serviceId: "api", check: "health_path", target: "/health" },
    { serviceId: "db", check: "db_connect" },
  ],
  confidence: 1,
};

const resources = [
  { serviceId: "api", publicUrl: "https://api.onrender.com" },
  { serviceId: "web", publicUrl: "https://web.vercel.app" },
];

describe("diagnosisFromVerifyOutcome", () => {
  it("maps cors_from failure to cors_failed", () => {
    const outcome: PlanVerifyOutcome = {
      serviceId: "api",
      check: "cors_from",
      ok: false,
      results: [
        {
          ok: false,
          statusCode: 200,
          url: "https://api.onrender.com/health",
          check: "cors_from",
          detail: "Missing Access-Control-Allow-Origin header",
          allowOrigin: null,
        },
      ],
    };
    const d = diagnosisFromVerifyOutcome(outcome, plan, resources);
    expect(d?.code).toBe("cors_failed");
    expect(d?.fromServiceId).toBe("web");
    expect(d?.toServiceId).toBe("api");
    expect(d?.action).toMatch(/CORS_ORIGIN/);
  });

  it("maps health_path failure to health_failed", () => {
    const outcome: PlanVerifyOutcome = {
      serviceId: "api",
      check: "health_path",
      ok: false,
      results: [
        {
          ok: false,
          statusCode: 500,
          url: "https://api.onrender.com/health",
          check: "health_path",
          detail: "status 500",
        },
      ],
    };
    const d = diagnosisFromVerifyOutcome(outcome, plan, resources);
    expect(d?.code).toBe("health_failed");
    expect(d?.serviceId).toBe("api");
  });

  it("maps db_connect failure to db_unreachable", () => {
    const outcome: PlanVerifyOutcome = {
      serviceId: "db",
      check: "db_connect",
      ok: false,
      results: [{ ok: false, statusCode: null, url: "", check: "db_connect", detail: "timeout" }],
    };
    const d = diagnosisFromVerifyOutcome(outcome, plan, resources);
    expect(d?.code).toBe("db_unreachable");
  });

  it("returns null for passes", () => {
    const outcome: PlanVerifyOutcome = {
      serviceId: "api",
      check: "health_path",
      ok: true,
      results: [],
    };
    expect(diagnosisFromVerifyOutcome(outcome, plan, resources)).toBeNull();
  });
});

describe("diagnosis helpers", () => {
  it("builds migration_failed", () => {
    const d = diagnosisForMigrationFailure({ managedId: "db", reason: "schema_missing" });
    expect(d.code).toBe("migration_failed");
    expect(d.action).toMatch(/Prisma/);
  });

  it("builds env_unresolved for missing secrets", () => {
    const d = diagnosisForEnvUnresolved({
      serviceId: "api",
      issues: ["missing_secret"],
    });
    expect(d.code).toBe("env_unresolved");
    expect(d.action).toMatch(/Environment/);
  });
});
