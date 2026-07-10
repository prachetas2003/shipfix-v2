import { describe, it, expect } from "vitest";
import {
  deriveLayers,
  latestResourceRows,
  providerConsoleUrl,
  roleForResource,
  toSnapshotResources,
  verificationFromEvents,
  diagnosesFromEvents,
  type PlanLite,
  type RawResourceRow,
} from "../src/snapshot";

const plan: PlanLite = {
  services: [
    { id: "api", type: "node_api", provider: "render" },
    { id: "web", type: "frontend_static", provider: "vercel" },
  ],
  verification: [
    { serviceId: "api", check: "health_path", target: "/health" },
    { serviceId: "web", check: "frontend_loads" },
  ],
};

function row(over: Partial<RawResourceRow>): RawResourceRow {
  return {
    serviceId: "web",
    kind: "service",
    provider: "vercel",
    externalId: "prj_1",
    url: "https://web.vercel.app",
    status: "live",
    exposesEnv: null,
    createdAt: "2026-06-03T00:00:00Z",
    ...over,
  };
}

describe("roleForResource", () => {
  it("maps managed db, backend, and frontend from the plan", () => {
    expect(roleForResource(row({ serviceId: "db", kind: "managed_db", provider: "neon" }), plan)).toBe(
      "database",
    );
    expect(roleForResource(row({ serviceId: "api", provider: "render" }), plan)).toBe("backend");
    expect(roleForResource(row({ serviceId: "web", provider: "vercel" }), plan)).toBe("frontend");
  });

  it("falls back to provider when plan is missing", () => {
    expect(roleForResource(row({ serviceId: "web", provider: "vercel" }), null)).toBe("frontend");
    expect(roleForResource(row({ serviceId: "api", provider: "render" }), null)).toBe("backend");
  });
});

describe("toSnapshotResources", () => {
  it("includes console deep links from externalId / meta", () => {
    const rows = [
      row({
        serviceId: "db",
        kind: "managed_db",
        provider: "neon",
        externalId: "neon-1",
        url: "db-host",
        exposesEnv: "DATABASE_URL",
      }),
      row({ serviceId: "api", provider: "render", externalId: "srv-1", url: "https://api.onrender.com" }),
      row({
        serviceId: "web",
        provider: "vercel",
        externalId: "prj_1",
        url: "https://web.vercel.app",
        meta: { consoleUrl: "https://vercel.com/team/app" },
      }),
    ];
    const resources = toSnapshotResources(rows, plan);
    expect(resources.find((r) => r.serviceId === "db")?.consoleUrl).toBe(
      "https://console.neon.tech/app/projects/neon-1",
    );
    expect(resources.find((r) => r.serviceId === "api")?.consoleUrl).toBe(
      "https://dashboard.render.com/web/srv-1",
    );
    expect(resources.find((r) => r.serviceId === "web")?.consoleUrl).toBe("https://vercel.com/team/app");
  });
});

describe("providerConsoleUrl", () => {
  it("prefers meta.consoleUrl over heuristics", () => {
    expect(providerConsoleUrl("vercel", "prj_1", { consoleUrl: "https://vercel.com/t/p" })).toBe(
      "https://vercel.com/t/p",
    );
    expect(providerConsoleUrl("vercel", "prj_1")).toBeNull();
  });
});

describe("deriveLayers", () => {
  it("reports full-stack live when db, backend, and frontend are all live", () => {
    const rows = [
      row({ serviceId: "db", kind: "managed_db", provider: "neon", url: "db-host", exposesEnv: "DATABASE_URL" }),
      row({ serviceId: "api", provider: "render", url: "https://api.onrender.com" }),
      row({ serviceId: "web", provider: "vercel", url: "https://web.vercel.app" }),
    ];
    const resources = toSnapshotResources(rows, plan);
    const layers = deriveLayers(resources, plan, [
      { serviceId: "api", check: "health_path", ok: true, skipped: false, statusCode: 200, url: "https://api.onrender.com/health", assumedPath: false },
      { serviceId: "web", check: "frontend_loads", ok: true, skipped: false, statusCode: 200, url: "https://web.vercel.app/", assumedPath: false },
    ]);
    expect(layers.frontend?.state).toBe("live");
    expect(layers.frontend?.url).toBe("https://web.vercel.app");
    expect(layers.backend?.state).toBe("live");
    expect(layers.fullStack.live).toBe(true);
  });

  it("marks frontend not_attempted and full-stack not live when only backend deployed", () => {
    const rows = [row({ serviceId: "api", provider: "render", url: "https://api.onrender.com" })];
    const resources = toSnapshotResources(rows, plan);
    const layers = deriveLayers(resources, plan, [
      { serviceId: "api", check: "health_path", ok: true, skipped: false, statusCode: 200, url: "https://api.onrender.com/health", assumedPath: false },
    ]);
    expect(layers.backend?.state).toBe("live");
    expect(layers.frontend?.state).toBe("not_attempted");
    expect(layers.fullStack.live).toBe(false);
  });

  it("does not report full-stack live when verification failed", () => {
    const rows = [
      row({ serviceId: "db", kind: "managed_db", provider: "neon", url: "db-host", exposesEnv: "DATABASE_URL" }),
      row({ serviceId: "api", provider: "render", url: "https://api.onrender.com" }),
      row({ serviceId: "web", provider: "vercel", url: "https://web.vercel.app" }),
    ];
    const resources = toSnapshotResources(rows, plan);
    const layers = deriveLayers(resources, plan, [
      { serviceId: "api", check: "health_path", ok: false, skipped: false, statusCode: 500, url: "https://api.onrender.com/health", assumedPath: false },
      { serviceId: "web", check: "frontend_loads", ok: true, skipped: false, statusCode: 200, url: "https://web.vercel.app/", assumedPath: false },
    ]);
    expect(layers.fullStack.live).toBe(false);
    expect(layers.fullStack.detail).toContain("verification failed");
  });

  it("does not report full-stack live when required cors_from fails", () => {
    const fullPlan: PlanLite = {
      ...plan,
      verification: [
        { serviceId: "api", check: "health_path", target: "/health" },
        { serviceId: "web", check: "frontend_loads" },
        { serviceId: "api", check: "cors_from", target: "web" },
      ],
    };
    const rows = [
      row({ serviceId: "db", kind: "managed_db", provider: "neon", url: "db-host", exposesEnv: "DATABASE_URL" }),
      row({ serviceId: "api", provider: "render", url: "https://api.onrender.com" }),
      row({ serviceId: "web", provider: "vercel", url: "https://web.vercel.app" }),
    ];
    const resources = toSnapshotResources(rows, fullPlan);
    const layers = deriveLayers(resources, fullPlan, [
      { serviceId: "api", check: "health_path", ok: true, skipped: false, statusCode: 200, url: "https://api.onrender.com/health", assumedPath: false },
      { serviceId: "web", check: "frontend_loads", ok: true, skipped: false, statusCode: 200, url: "https://web.vercel.app/", assumedPath: false },
      { serviceId: "api", check: "cors_from", ok: false, skipped: false, statusCode: 200, url: "https://api.onrender.com/health", assumedPath: false },
    ]);
    expect(layers.fullStack.live).toBe(false);
    expect(layers.fullStack.detail).toContain("verification failed");
  });

  it("maps frontend_ssr to the frontend layer", () => {
    const nextPlan: PlanLite = {
      services: [{ id: "web", type: "frontend_ssr", provider: "vercel" }],
      verification: [{ serviceId: "web", check: "frontend_loads" }],
    };
    expect(roleForResource(row({ serviceId: "web", provider: "vercel" }), nextPlan)).toBe("frontend");
  });
});

describe("verificationFromEvents", () => {
  it("extracts only verification events", () => {
    const entries = verificationFromEvents([
      { data: { event: "deploy_started" } },
      { data: { event: "verification", serviceId: "api", check: "health_path", ok: true, statusCode: 200 } },
      { data: { event: "verification", managedId: "db", check: "db_connect", ok: false } },
      { data: null },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ serviceId: "api", check: "health_path", ok: true, statusCode: 200 });
    expect(entries[1]).toMatchObject({ serviceId: "db", check: "db_connect", ok: false });
  });
});

describe("diagnosesFromEvents", () => {
  it("extracts structured diagnoses and dedupes", () => {
    const entries = diagnosesFromEvents([
      {
        data: {
          event: "verification",
          diagnosis: {
            code: "cors_failed",
            fromServiceId: "web",
            toServiceId: "api",
            action: "Set CORS_ORIGIN",
          },
        },
      },
      {
        data: {
          event: "verification",
          diagnosis: {
            code: "cors_failed",
            fromServiceId: "web",
            toServiceId: "api",
            action: "Set CORS_ORIGIN",
          },
        },
      },
      {
        data: {
          event: "migration_failed",
          diagnosis: { code: "migration_failed", managedId: "db", action: "Fix migration" },
        },
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.code).toBe("cors_failed");
    expect(entries[1]?.code).toBe("migration_failed");
  });
});
