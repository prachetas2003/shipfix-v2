import { describe, it, expect } from "vitest";
import type { DeploymentPlan } from "@shipfix/contracts";
import { capabilities } from "@shipfix/validator";
import {
  computeFinalizeDeployOutcome,
  evaluateDeployGate,
  type DeployRunOutcome,
} from "../src/finalizeDeployRun";

const emptyOutcome = (): DeployRunOutcome => ({
  provision: { provisioned: [], failed: [], skipped: [] },
  backendDeploy: { deployed: [], failed: [], skipped: [] },
  frontendDeploy: { deployed: [], failed: [], skipped: [] },
  verify: { passed: [], failed: [], skipped: [] },
});

const fullStackPlan: DeploymentPlan = {
  goal: "deploy",
  classification: "deployable",
  services: [
    { id: "api", type: "node_api", provider: "render", rootDir: "apps/api", install: null, build: null, start: null, outputDir: null, healthCheckPath: "/health", env: [], evidence: [] },
    { id: "web", type: "frontend_static", provider: "vercel", rootDir: "apps/web", install: null, build: null, start: null, outputDir: "dist", healthCheckPath: null, env: [], evidence: [] },
  ],
  managed: [{ id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" }],
  wiring: [],
  deployOrder: ["db", "api", "web"],
  questions: [],
  blockers: [],
  verification: [{ serviceId: "api", check: "health_path", target: "/health" }],
  confidence: 0.9,
};

const caps = capabilities(
  { vercel: ["frontend_static"], render: ["node_api"] },
  ["neon"],
);

describe("computeFinalizeDeployOutcome", () => {
  it("returns diagnosed when frontend times out but backend is live", () => {
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.failed = [{ id: "web", kind: "timeout" }];
    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("diagnosed");
    expect(result.message).toContain("frontend did not deploy");
  });

  it("returns diagnosed when Vercel setup blocker but backend and DB are live", () => {
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.failed = [{ id: "web", kind: "setup_blocker" }];
    outcome.verify.failed = [{ serviceId: "api", check: "http_2xx" }];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("diagnosed");
    expect(result.message).toContain("setup required");
    expect(result.message).not.toContain("failed with no useful");
  });

  it("returns diagnosed when Vercel project limit is hit", () => {
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.failed = [{ id: "web", kind: "provider_limit" }];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("diagnosed");
    expect(result.message).toContain("too many Vercel projects");
    expect(result.message).not.toContain("repo script");
  });

  it("returns failed when nothing live was produced", () => {
    const outcome = emptyOutcome();
    outcome.backendDeploy.failed = [{ id: "api", kind: "deploy_failed" }];
    outcome.frontendDeploy.failed = [{ id: "web", kind: "setup_blocker" }];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("failed");
  });

  it("returns succeeded when all services live and checks pass", () => {
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.deployed = ["web"];
    outcome.verify.passed = [{ serviceId: "api", check: "health_path" }];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("succeeded");
  });

  it("returns failed when database verification fails before services deploy", () => {
    const outcome = emptyOutcome();
    outcome.provision.failed = ["db"];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Database");
    expect(result.message).toContain("No app was marked live");
  });

  it("returns diagnosed when services are live but database verification failed", () => {
    const outcome = emptyOutcome();
    outcome.provision.failed = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.deployed = ["web"];
    outcome.verify.passed = [{ serviceId: "api", check: "health_path" }];

    const result = computeFinalizeDeployOutcome(fullStackPlan, outcome, caps);
    expect(result.status).toBe("diagnosed");
    expect(result.message).toContain("Database");
    expect(result.message).toContain("NOT live");
  });

  it("requires db_connect when present in the plan", () => {
    const planWithDbCheck: DeploymentPlan = {
      ...fullStackPlan,
      verification: [
        { serviceId: "api", check: "health_path", target: "/health" },
        { serviceId: "web", check: "frontend_loads" },
        { serviceId: "db", check: "db_connect" },
      ],
    };
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.deployed = ["web"];
    outcome.verify.passed = [
      { serviceId: "api", check: "health_path" },
      { serviceId: "web", check: "frontend_loads" },
    ];
    outcome.verify.skipped = [
      { serviceId: "db", check: "db_connect", reason: "database connection not available" },
    ];

    const result = computeFinalizeDeployOutcome(planWithDbCheck, outcome, caps);
    expect(result.status).not.toBe("succeeded");
  });

  it("does not succeed when cors_from fails", () => {
    const planWithCors: DeploymentPlan = {
      ...fullStackPlan,
      verification: [
        { serviceId: "api", check: "health_path", target: "/health" },
        { serviceId: "web", check: "frontend_loads" },
        { serviceId: "api", check: "cors_from", target: "web" },
      ],
    };
    const outcome = emptyOutcome();
    outcome.provision.provisioned = ["db"];
    outcome.backendDeploy.deployed = ["api"];
    outcome.frontendDeploy.deployed = ["web"];
    outcome.verify.passed = [
      { serviceId: "api", check: "health_path" },
      { serviceId: "web", check: "frontend_loads" },
    ];
    outcome.verify.failed = [{ serviceId: "api", check: "cors_from" }];

    const result = computeFinalizeDeployOutcome(planWithCors, outcome, caps);
    expect(result.status).not.toBe("succeeded");
  });
});

describe("evaluateDeployGate", () => {
  it("allows a deployable (GREEN) plan", () => {
    const gate = evaluateDeployGate(fullStackPlan);
    expect(gate.allow).toBe(true);
  });

  it("blocks a needs_setup (YELLOW) plan as diagnosed, no providers called", () => {
    const gate = evaluateDeployGate({ ...fullStackPlan, classification: "needs_setup" });
    expect(gate.allow).toBe(false);
    expect(gate.status).toBe("diagnosed");
    expect(gate.message).toContain("No providers were called");
  });

  it("blocks a diagnose_only (RED) plan as diagnosed", () => {
    const gate = evaluateDeployGate({ ...fullStackPlan, classification: "diagnose_only" });
    expect(gate.allow).toBe(false);
    expect(gate.status).toBe("diagnosed");
  });
});
