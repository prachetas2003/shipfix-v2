import { describe, expect, it } from "vitest";
import { apiControlPlaneDiagnostics, workerHeartbeatDiagnostics } from "../src/configCheck";
import { EnvSchema } from "../src/env";

describe("apiControlPlaneDiagnostics", () => {
  it("exposes safe db fingerprint and temporal settings", () => {
    const heartbeatAt = new Date();
    const env = EnvSchema.parse({
      DATABASE_URL: "postgres://shipfix:shipfix@localhost:5432/shipfix",
      TEMPORAL_ADDRESS: "localhost:7233",
      TEMPORAL_TASK_QUEUE: "shipfix",
      TEMPORAL_NAMESPACE: "default",
    });
    const diag = apiControlPlaneDiagnostics(
      env,
      {
        rootEnvPath: "/repo/.env",
        appLocalEnvPath: "/repo/apps/api/.env.local",
        rootEnvExists: true,
        appLocalEnvExists: false,
        rootEnvLoaded: true,
        appLocalEnvLoaded: false,
        rootEnvOverride: true,
        appLocalEnvOverride: true,
        envSourcePath: "repo-root/.env",
      },
      {
        lastSeenAt: heartbeatAt,
        taskQueue: "shipfix",
        temporalAddress: "localhost:7233",
        temporalNamespace: "default",
        status: "polling",
      },
      { reachable: true, checkedAt: "2026-06-15T12:00:00.000Z", error: null },
    );

    expect(diag.databaseUrlPresent).toBe(true);
    expect(diag.apiDbFingerprint.databaseName).toBe("shipfix");
    expect(diag.apiDbFingerprint.envSourcePath).toBe("repo-root/.env");
    expect(diag.temporalAddress).toBe("localhost:7233");
    expect(diag.temporalTaskQueue).toMatch(/^shipfix-[0-9a-f]{12}$/);
    expect(diag.temporalReachable).toBe(true);
    expect(diag.workerRecentlySeen).toBe(true);
    expect(diag.lastWorkerHeartbeatAt).toBe(heartbeatAt.toISOString());
    expect(JSON.stringify(diag)).not.toContain("shipfix:shipfix");
  });

  it("marks old worker heartbeats as not recently seen", () => {
    const diag = workerHeartbeatDiagnostics(
      {
        lastSeenAt: "2026-06-15T12:00:00.000Z",
        taskQueue: "shipfix",
        temporalAddress: "localhost:7233",
        temporalNamespace: "default",
        status: "polling",
      },
      new Date("2026-06-15T12:02:00.000Z"),
      60_000,
    );

    expect(diag.workerRecentlySeen).toBe(false);
    expect(diag.workerHeartbeatAgeMs).toBe(120_000);
  });
});

describe("run lifecycle ordering", () => {
  it("starts workflow only after the run row is readable", async () => {
    const { assertRunPersisted, startWorkflowAfterPersistedRun } = await import("../src/runLifecycle");
    const order: string[] = [];
    const runId = "11111111-1111-4111-8111-111111111111";
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              order.push("assert");
              return [{ id: runId }];
            },
          }),
        }),
      }),
    };

    await startWorkflowAfterPersistedRun(db as never, runId, async () => {
      order.push("workflow");
    });

    expect(order).toEqual(["assert", "workflow"]);
  });

  it("throws when the run row is not readable before workflow start", async () => {
    const { assertRunPersisted } = await import("../src/runLifecycle");
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    await expect(assertRunPersisted(db as never, "22222222-2222-4222-8222-222222222222")).rejects.toThrow(
      /not readable immediately after insert/,
    );
  });
});

describe("env path resolution", () => {
  it("shares repo-root .env between API and worker but uses distinct app-local overrides", async () => {
    const { apiEnvPaths, workerEnvPaths } = await import("../src/runLifecycle");
    const api = apiEnvPaths(new URL("../src/env.ts", import.meta.url).href);
    const worker = workerEnvPaths(new URL("../../worker/src/index.ts", import.meta.url).href);

    expect(api.rootEnvPath).toBe(worker.rootEnvPath);
    expect(api.rootEnvPath).toMatch(/\.env$/);
    const norm = (p: string) => p.replace(/\\/g, "/");
    expect(norm(api.appLocalEnvPath)).toContain("apps/api");
    expect(norm(worker.appLocalEnvPath)).toContain("apps/worker");
    expect(api.appLocalEnvPath).not.toBe(worker.appLocalEnvPath);
  });
});
