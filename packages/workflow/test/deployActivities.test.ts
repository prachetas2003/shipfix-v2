/**
 * Targeted activity tests for deployBackendServices / deployFrontendServices
 * with a mocked DB, adapters, vault, and logger. These pin the three behaviors
 * a live run depends on:
 *   1. env-blocked skip (missing dependency -> skip + deploy_env_blocked, no
 *      provider call),
 *   2. failure-kind propagation (adapter failureKind -> summary + run event),
 *   3. partial-progress persistence (every attempt recorded in
 *      deployed_resources; earlier live rows untouched).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentPlan } from "@shipfix/contracts";

interface FakeRow {
  [key: string]: unknown;
}

const h = vi.hoisted(() => {
  const rows: Record<string, FakeRow[]> = {
    runs: [],
    projects: [],
    plans: [],
    provider_accounts: [],
    deployed_resources: [],
    run_inputs: [],
    llm_usage: [],
  };
  const events: Array<{ level: string; message: string; data: Record<string, unknown> }> = [];
  const adapterBehavior = {
    render: { deploy: async (_input: unknown): Promise<unknown> => ({ ok: true, externalId: "srv-1", publicUrl: "https://api.onrender.com", status: "live", logs: "" }) },
    vercel: { deploy: async (_input: unknown): Promise<unknown> => ({ ok: true, externalId: "dep-1", publicUrl: "https://web.vercel.app", status: "live", logs: "" }) },
    renderCalls: [] as unknown[],
    vercelCalls: [] as unknown[],
  };
  return { rows, events, adapterBehavior };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  gte: (col: unknown, val: unknown) => ({ gte: [col, val] }),
  desc: (col: unknown) => col,
  asc: (col: unknown) => col,
  sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings, vals }), {
    raw: (s: string) => ({ sql: s }),
  }),
}));

vi.mock("@shipfix/db", () => {
  const table = (name: string): Record<string, unknown> =>
    new Proxy({ __table: name }, { get: (t, prop) => (prop === "__table" ? name : { table: name, column: prop }) });

  const tables = {
    runs: table("runs"),
    projects: table("projects"),
    plans: table("plans"),
    providerAccounts: table("provider_accounts"),
    deployedResources: table("deployed_resources"),
    runInputs: table("run_inputs"),
    llmUsage: table("llm_usage"),
  };
  const rowsFor = (t: { __table?: string }): FakeRow[] => h.rows[(t as { __table: string }).__table];

  // Interpret the conditions produced by the mocked drizzle-orm eq/and/gte.
  type Cond = { and?: Cond[]; eq?: [{ column: string }, unknown]; gte?: [{ column: string }, unknown] } | undefined;
  const matches = (row: FakeRow, cond: Cond): boolean => {
    if (!cond) return true;
    if (cond.and) return cond.and.filter(Boolean).every((c) => matches(row, c));
    if (cond.eq) return row[cond.eq[0].column] === cond.eq[1];
    if (cond.gte) return (row[cond.gte[0].column] as number | Date) >= (cond.gte[1] as number | Date);
    return true; // raw sql fragments — cannot evaluate, treat as match-all
  };

  class Query implements PromiseLike<FakeRow[]> {
    private cond: Cond;
    constructor(private readonly table: { __table: string }) {}
    where(cond: Cond): this {
      this.cond = cond;
      return this;
    }
    orderBy(): this {
      return this;
    }
    limit(): this {
      return this;
    }
    then<T1, T2>(
      onfulfilled?: ((value: FakeRow[]) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      const result = rowsFor(this.table).filter((r) => matches(r, this.cond));
      return Promise.resolve(result).then(onfulfilled, onrejected);
    }
  }

  const db = {
    select: (..._cols: unknown[]) => ({ from: (t: { __table: string }) => new Query(t) }),
    insert: (t: { __table: string }) => ({
      values: (vals: FakeRow) => {
        const row = { id: `row-${Math.random().toString(36).slice(2, 8)}`, ...vals };
        const done = Promise.resolve().then(() => void rowsFor(t).push(row));
        return {
          returning: async () => {
            await done;
            return [row];
          },
          then: <T1, T2>(
            onfulfilled?: ((value: void) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
          ) => done.then(onfulfilled, onrejected),
        };
      },
    }),
    update: (t: { __table: string }) => ({
      set: (vals: FakeRow) => ({
        where: () => {
          const target = rowsFor(t)[0];
          if (target) Object.assign(target, vals);
          return Promise.resolve();
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async () => [],
  };

  return { ...tables, createDb: () => db };
});

vi.mock("@shipfix/observability", () => {
  const push = (level: string) => (message: string, data: Record<string, unknown> = {}) => {
    h.events.push({ level, message, data });
    return Promise.resolve();
  };
  return {
    createRunLogger: () => ({
      log: push("info"),
      warn: push("warn"),
      error: push("error"),
      stage: (stage: string, message: string) => {
        h.events.push({ level: "info", message, data: { stage } });
        return Promise.resolve();
      },
    }),
    createSafePostgresSink: () => ({ emit: async () => {} }),
    createPostgresSink: () => ({ emit: async () => {} }),
  };
});

vi.mock("@shipfix/secrets", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createSecretVaultFromEnv: () => ({
      seal: async (plaintext: string) => ({
        encDek: Buffer.from("dek"),
        encBlob: Buffer.from(plaintext),
        encIv: Buffer.from("iv"),
      }),
      open: async (sealed: { encBlob: Buffer }) => sealed.encBlob.toString("utf8"),
    }),
  };
});

vi.mock("@shipfix/adapter-render", () => ({
  createRenderAdapter: () => ({
    id: "render",
    supports: ["node_api"],
    requiredCredentials: () => ({ provider: "render", required: ["apiKey"] }),
    deploy: (input: unknown) => {
      h.adapterBehavior.renderCalls.push(input);
      return h.adapterBehavior.render.deploy(input);
    },
    waitForReady: async () => ({ ok: true, externalId: "srv-1", publicUrl: "https://api.onrender.com", status: "live", logs: "" }),
    setEnv: async () => {},
    teardown: async () => {},
  }),
}));

vi.mock("@shipfix/adapter-vercel", () => ({
  createVercelAdapter: () => ({
    id: "vercel",
    supports: ["frontend_static"],
    requiredCredentials: () => ({ provider: "vercel", required: ["apiToken"] }),
    deploy: (input: unknown) => {
      h.adapterBehavior.vercelCalls.push(input);
      return h.adapterBehavior.vercel.deploy(input);
    },
    waitForReady: async () => ({ ok: true, externalId: "dep-1", publicUrl: "https://web.vercel.app", status: "live", logs: "" }),
    setEnv: async () => {},
    teardown: async () => {},
  }),
}));

process.env.DATABASE_URL = "postgres://fake/fake";

import { deployBackendServices, deployFrontendServices } from "../src/activities";

const RUN_ID = "run-1";

const plan: DeploymentPlan = {
  goal: "deploy",
  classification: "deployable",
  services: [
    {
      id: "api",
      type: "node_api",
      provider: "render",
      rootDir: "apps/api",
      install: "pnpm install",
      build: null,
      start: "pnpm run start",
      outputDir: null,
      healthCheckPath: "/health",
      healthCandidates: ["/health"],
      env: [
        { name: "PORT", source: "provider_injected" },
        { name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" },
      ],
      evidence: [],
    },
    {
      id: "web",
      type: "frontend_static",
      provider: "vercel",
      rootDir: "apps/web",
      install: "pnpm install",
      build: "pnpm run build",
      start: null,
      outputDir: "dist",
      healthCheckPath: null,
      healthCandidates: [],
      env: [{ name: "VITE_API_URL", source: "generated_from_service", ref: "api.publicUrl" }],
      evidence: [],
    },
  ],
  managed: [
    { id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" },
  ],
  wiring: [],
  deployOrder: ["db", "api", "web"],
  questions: [],
  blockers: [],
  verification: [],
  confidence: 0.95,
  planSource: "deterministic",
};

function liveDbRow(): FakeRow {
  return {
    runId: RUN_ID,
    serviceId: "db",
    kind: "managed_db",
    provider: "neon",
    externalId: "neon-1",
    url: "db.neon.tech",
    status: "live",
    exposesEnv: "DATABASE_URL",
    encDek: Buffer.from("dek"),
    encBlob: Buffer.from("postgres://user:pass@db.neon.tech/app"),
    encIv: Buffer.from("iv"),
  };
}

function liveApiRow(): FakeRow {
  return {
    runId: RUN_ID,
    serviceId: "api",
    kind: "service",
    provider: "render",
    externalId: "srv-1",
    url: "https://api.onrender.com",
    status: "live",
    exposesEnv: null,
    encDek: null,
    encBlob: null,
    encIv: null,
  };
}

beforeEach(() => {
  for (const key of Object.keys(h.rows)) h.rows[key] = [];
  h.events.length = 0;
  h.adapterBehavior.renderCalls.length = 0;
  h.adapterBehavior.vercelCalls.length = 0;
  h.adapterBehavior.render.deploy = async () => ({ ok: true, externalId: "srv-1", publicUrl: "https://api.onrender.com", status: "live", logs: "" });
  h.adapterBehavior.vercel.deploy = async () => ({ ok: true, externalId: "dep-1", publicUrl: "https://web.vercel.app", status: "live", logs: "" });

  h.rows.runs.push({ id: RUN_ID, projectId: "proj-1", commitSha: "a".repeat(40), mode: "deploy", status: "deploying" });
  h.rows.projects.push({ id: "proj-1", userId: "user-1", repoFullName: "acme/app", defaultBranch: "main" });
  h.rows.plans.push({ id: "plan-1", runId: RUN_ID, version: 1, doc: plan });
  h.rows.provider_accounts.push(
    { id: "acc-r", userId: "user-1", provider: "render", encDek: Buffer.from("dek"), encBlob: Buffer.from(JSON.stringify({ apiKey: "rnd_k" })), encIv: Buffer.from("iv") },
    { id: "acc-v", userId: "user-1", provider: "vercel", encDek: Buffer.from("dek"), encBlob: Buffer.from(JSON.stringify({ apiToken: "vc_k" })), encIv: Buffer.from("iv") },
  );
});

describe("deployBackendServices", () => {
  it("skips with deploy_env_blocked when the database is not live yet (no provider call)", async () => {
    // No deployed db row -> DATABASE_URL cannot resolve.
    const summary = await deployBackendServices(RUN_ID);

    expect(summary.deployed).toEqual([]);
    expect(summary.skipped).toEqual([{ id: "api", reason: "missing_managed" }]);
    expect(h.adapterBehavior.renderCalls).toHaveLength(0);
    const blocked = h.events.find((e) => e.data.event === "deploy_env_blocked");
    expect(blocked).toBeDefined();
    expect(blocked?.data.serviceId).toBe("api");
  });

  it("deploys and persists a live row when env resolves", async () => {
    h.rows.deployed_resources.push(liveDbRow());

    const summary = await deployBackendServices(RUN_ID);

    expect(summary.deployed).toEqual(["api"]);
    expect(h.adapterBehavior.renderCalls).toHaveLength(1);
    const call = h.adapterBehavior.renderCalls[0] as { resourceName: string; existingExternalId?: string };
    expect(call.resourceName).toBe("sf-proj1-api");
    expect(call.resourceName).not.toContain(RUN_ID);
    const apiRow = h.rows.deployed_resources.find((r) => r.serviceId === "api");
    expect(apiRow).toMatchObject({ status: "live", url: "https://api.onrender.com", provider: "render" });
    const deployedEvent = h.events.find((e) => e.data.event === "service_deployed");
    expect(deployedEvent?.data.publicUrl).toBe("https://api.onrender.com");
  });

  it("reuses a persisted Render service id from an earlier run", async () => {
    h.rows.deployed_resources.push(liveDbRow(), {
      runId: "run-old",
      serviceId: "api",
      kind: "service",
      provider: "render",
      externalId: "srv-persisted",
      url: null,
      status: "failed",
    });
    h.rows.runs.push({ id: "run-old", projectId: "proj-1", commitSha: "b".repeat(40), mode: "deploy", status: "failed" });

    await deployBackendServices(RUN_ID);

    const call = h.adapterBehavior.renderCalls[0] as { existingExternalId?: string; resourceName: string };
    expect(call.existingExternalId).toBe("srv-persisted");
    expect(call.resourceName).toBe("sf-proj1-api");
  });

  it("propagates the adapter failureKind and persists the failed attempt", async () => {
    h.rows.deployed_resources.push(liveDbRow());
    h.adapterBehavior.render.deploy = async () => ({
      ok: false,
      externalId: "srv-1",
      publicUrl: null,
      status: "build_failed",
      failureKind: "build_failed",
      logs: "tsc: not found",
    });

    const summary = await deployBackendServices(RUN_ID);

    expect(summary.failed).toEqual([{ id: "api", kind: "build_failed" }]);
    // Partial progress is persisted: the attempt is recorded as failed, and
    // the database row stays live and untouched.
    const apiRow = h.rows.deployed_resources.find((r) => r.serviceId === "api");
    expect(apiRow?.status).toBe("failed");
    const dbRow = h.rows.deployed_resources.find((r) => r.serviceId === "db");
    expect(dbRow?.status).toBe("live");
    const failedEvent = h.events.find((e) => e.data.event === "deploy_failed");
    expect(failedEvent?.data.failureKind).toBe("build_failed");
  });

  it("skips with a credential warning when Render is not connected", async () => {
    h.rows.provider_accounts = h.rows.provider_accounts.filter((a) => a.provider !== "render");
    h.rows.deployed_resources.push(liveDbRow());

    const summary = await deployBackendServices(RUN_ID);

    expect(summary.skipped).toEqual([{ id: "api", reason: "render_not_connected" }]);
    expect(h.adapterBehavior.renderCalls).toHaveLength(0);
    expect(h.events.some((e) => e.data.event === "deploy_needs_credential")).toBe(true);
  });
});

describe("deployFrontendServices", () => {
  it("skips with deploy_env_blocked when the backend is not live yet", async () => {
    // db live, but no live api row -> VITE_API_URL cannot resolve.
    h.rows.deployed_resources.push(liveDbRow());

    const summary = await deployFrontendServices(RUN_ID);

    expect(summary.skipped).toEqual([{ id: "web", reason: "missing_service" }]);
    expect(h.adapterBehavior.vercelCalls).toHaveLength(0);
    expect(h.events.some((e) => e.data.event === "deploy_env_blocked")).toBe(true);
  });

  it("propagates a timeout failureKind and keeps earlier live rows untouched", async () => {
    h.rows.deployed_resources.push(liveDbRow(), liveApiRow());
    h.adapterBehavior.vercel.deploy = async () => ({
      ok: false,
      externalId: "dep-1",
      publicUrl: null,
      status: "timeout",
      failureKind: "timeout",
      logs: "vercel polling timed out",
    });

    const summary = await deployFrontendServices(RUN_ID);

    expect(summary.failed).toEqual([{ id: "web", kind: "timeout" }]);
    const webRow = h.rows.deployed_resources.find((r) => r.serviceId === "web");
    expect(webRow?.status).toBe("failed");
    expect(h.rows.deployed_resources.find((r) => r.serviceId === "api")?.status).toBe("live");
    expect(h.rows.deployed_resources.find((r) => r.serviceId === "db")?.status).toBe("live");
  });

  it("deploys the frontend with the backend URL wired in", async () => {
    h.rows.deployed_resources.push(liveDbRow(), liveApiRow());

    const summary = await deployFrontendServices(RUN_ID);

    expect(summary.deployed).toEqual(["web"]);
    const call = h.adapterBehavior.vercelCalls[0] as {
      env: Record<string, string>;
      resourceName: string;
      existingExternalId?: string;
    };
    expect(call.env.VITE_API_URL).toBe("https://api.onrender.com");
    expect(call.resourceName).toBe("sf-proj1-web");
    expect(call.resourceName).not.toContain(RUN_ID);
    expect(call.existingExternalId).toBeUndefined();
    const webRow = h.rows.deployed_resources.find((r) => r.serviceId === "web");
    expect(webRow).toMatchObject({ status: "live", url: "https://web.vercel.app" });
  });

  it("reuses a persisted Vercel project id from an earlier run of the same ShipFix project", async () => {
    h.rows.deployed_resources.push(liveDbRow(), liveApiRow(), {
      runId: "run-old",
      serviceId: "web",
      kind: "service",
      provider: "vercel",
      externalId: "prj-persisted",
      url: null,
      status: "failed",
    });
    h.rows.runs.push({ id: "run-old", projectId: "proj-1", commitSha: "b".repeat(40), mode: "deploy", status: "failed" });

    await deployFrontendServices(RUN_ID);

    const call = h.adapterBehavior.vercelCalls[0] as { existingExternalId?: string; resourceName: string };
    expect(call.existingExternalId).toBe("prj-persisted");
    expect(call.resourceName).toBe("sf-proj1-web");
  });

  it("does not emit repo fix guidance for provider project limit failures", async () => {
    h.rows.deployed_resources.push(liveDbRow(), liveApiRow());
    h.adapterBehavior.vercel.deploy = async () => ({
      ok: false,
      externalId: null,
      publicUrl: null,
      status: "deploy_failed",
      failureKind: "provider_limit",
      logs:
        "Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects.",
    });

    const summary = await deployFrontendServices(RUN_ID);

    expect(summary.failed).toEqual([{ id: "web", kind: "provider_limit" }]);
    expect(h.events.some((e) => e.data.event === "deploy_fix_guidance")).toBe(false);
    expect(h.events.some((e) => e.data.event === "deploy_provider_limit")).toBe(true);
  });

  it("does not emit repo fix guidance for provider env var conflicts", async () => {
    h.rows.deployed_resources.push(liveDbRow(), liveApiRow());
    h.adapterBehavior.vercel.deploy = async () => ({
      ok: false,
      externalId: "prj_1",
      publicUrl: null,
      status: "deploy_failed",
      failureKind: "provider_env_conflict",
      logs: "Vercel env var conflict for VITE_API_URL: ShipFix could not replace the env var after retry.",
    });

    const summary = await deployFrontendServices(RUN_ID);

    expect(summary.failed).toEqual([{ id: "web", kind: "provider_env_conflict" }]);
    expect(h.events.some((e) => e.data.event === "deploy_fix_guidance")).toBe(false);
    expect(h.events.some((e) => e.data.event === "deploy_provider_env_conflict")).toBe(true);
  });
});
