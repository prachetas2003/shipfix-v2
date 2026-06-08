import { describe, it, expect } from "vitest";
import type { PlanService } from "@shipfix/contracts";
import { createRenderAdapter } from "../src/index";

const service: PlanService = {
  id: "api",
  type: "node_api",
  provider: "render",
  rootDir: "apps/api",
  install: "npm install",
  build: "npm run build",
  start: "npm run start",
  outputDir: null,
  healthCheckPath: "/health",
  env: [],
  evidence: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRenderAdapter", () => {
  it("creates a web service and waits for deploy live", async () => {
    const calls: string[] = [];
    let deployPolls = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u}`);

      if (u.includes("/owners")) {
        return jsonResponse([{ owner: { id: "own_1" } }]);
      }
      if (u.includes("/deploys") && method === "POST") {
        return jsonResponse({ deploy: { id: "dpl_1", status: "created" } });
      }
      if (u.includes("/deploys/dpl_1") && method === "GET") {
        deployPolls++;
        return jsonResponse({ deploy: { id: "dpl_1", status: deployPolls >= 2 ? "live" : "build_in_progress" } });
      }
      if (u.includes("/services/srv_1") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_1", serviceDetails: { url: "https://api.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse([]);
      }
      if (u.endsWith("/services") && method === "POST") {
        return jsonResponse({ service: { id: "srv_1", name: "shipfix-api" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://render.test/v1",
      pollIntervalMs: 1,
      deployTimeoutMs: 5_000,
    });

    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      resourceName: "shipfix-run-api",
      env: { DATABASE_URL: "postgres://secret" },
      credentials: { provider: "render", values: { apiKey: "rnd_test" } },
    });

    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("srv_1");
    expect(result.publicUrl).toBe("https://api.onrender.com");
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/services"))).toBe(true);
    const createCall = calls.find((c) => c.startsWith("POST") && c.endsWith("/services"));
    expect(createCall).toBeDefined();
  });

  it("surfaces useful detail when deploy ends build_failed", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/owners")) return jsonResponse([{ owner: { id: "own_1" } }]);
      if (u.includes("/deploys") && method === "POST") {
        return jsonResponse({ deploy: { id: "dpl_fail" } });
      }
      if (u.includes("/deploys/dpl_fail")) {
        return jsonResponse({ deploy: { id: "dpl_fail", status: "build_failed" } });
      }
      if (u.includes("/services/srv_1") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_1", serviceDetails: { url: "https://api.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET") return jsonResponse([]);
      if (u.endsWith("/services") && method === "POST") {
        return jsonResponse({ service: { id: "srv_1" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://render.test/v1",
      pollIntervalMs: 1,
      deployTimeoutMs: 5_000,
    });

    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      resourceName: "shipfix-api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.externalId).toBe("srv_1");
    expect(result.status).toBe("build_failed");
    expect(result.failureKind).toBe("build_failed");
    expect(result.logs).toContain("srv_1");
    expect(result.logs).toContain("dpl_fail");
    expect(result.logs).toContain("build_failed");
    expect(result.logs).toContain("Render dashboard");
    expect(result.logs).not.toContain("Unexpected end of JSON input");
  });

  it("propagates a timeout failureKind when the deploy never reaches terminal", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/owners")) return jsonResponse([{ owner: { id: "own_1" } }]);
      if (u.includes("/deploys") && method === "POST") return jsonResponse({ deploy: { id: "dpl_slow" } });
      if (u.includes("/deploys/dpl_slow")) {
        return jsonResponse({ deploy: { id: "dpl_slow", status: "build_in_progress" } });
      }
      if (u.includes("/services/srv_1") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_1", serviceDetails: { url: "https://api.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET") return jsonResponse([]);
      if (u.endsWith("/services") && method === "POST") return jsonResponse({ service: { id: "srv_1" } });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://render.test/v1",
      pollIntervalMs: 1,
      deployTimeoutMs: 10,
    });

    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      resourceName: "shipfix-api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.failureKind).toBe("timeout");
  });

  it("returns timeout failure when a Render HTTP request hangs", async () => {
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://render.test/v1",
      httpTimeoutMs: 20,
    });

    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      resourceName: "shipfix-api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.failureKind).toBe("timeout");
    expect(result.logs).toMatch(/timed out/i);
  });

  it("resolves deploy id when trigger deploy returns empty body", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/owners")) return jsonResponse([{ owner: { id: "own_1" } }]);
      if (u.includes("/deploys") && method === "POST") {
        return new Response("", { status: 202, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/deploys?") && method === "GET") {
        return jsonResponse([{ deploy: { id: "dpl_empty", status: "created" } }]);
      }
      if (u.includes("/deploys/dpl_empty")) {
        return jsonResponse({ deploy: { id: "dpl_empty", status: "live" } });
      }
      if (u.includes("/services/srv_1") && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_1", serviceDetails: { url: "https://api.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET") return jsonResponse([]);
      if (u.endsWith("/services") && method === "POST") {
        return jsonResponse({ service: { id: "srv_1" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({ fetchImpl: fakeFetch, apiBase: "https://render.test/v1", pollIntervalMs: 1 });
    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("dpl_empty");
  });

  it("includes install and build in Render buildCommand", async () => {
    let createBody: Record<string, unknown> | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/owners")) return jsonResponse([{ owner: { id: "own_1" } }]);
      if (u.endsWith("/services") && method === "POST") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ service: { id: "srv_1" } });
      }
      if (u.includes("/deploys") && method === "POST") {
        return jsonResponse({ deploy: { id: "dpl_1", status: "live" } });
      }
      if (u.includes("/deploys/dpl_1")) {
        return jsonResponse({ deploy: { id: "dpl_1", status: "live" } });
      }
      if (u.includes("/services/srv_1") && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_1", serviceDetails: { url: "https://x.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET") return jsonResponse([]);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({ fetchImpl: fakeFetch, apiBase: "https://render.test/v1", pollIntervalMs: 1 });
    await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "apps/api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });

    const details = (createBody as { serviceDetails?: { envSpecificDetails?: { buildCommand?: string } } } | null)
      ?.serviceDetails?.envSpecificDetails;
    expect(details?.buildCommand).toBe("npm install && npm run build");
  });

  it("updates an existing service by name instead of creating duplicate", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/owners")) return jsonResponse([{ owner: { id: "own_1" } }]);
      if (u.includes("/deploys") && method === "POST") {
        return jsonResponse({ deploy: { id: "dpl_1", status: "created" } });
      }
      if (u.includes("/deploys/dpl_1") && method === "GET") {
        return jsonResponse({ deploy: { id: "dpl_1", status: "live" } });
      }
      if (u.includes("/services/srv_existing") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse({ service: { id: "srv_existing", serviceDetails: { url: "https://x.onrender.com" } } });
      }
      if (u.includes("/services") && method === "GET" && !u.includes("/deploys")) {
        return jsonResponse([{ service: { id: "srv_existing", name: "shipfix-run-api" } }]);
      }
      if (u.includes("/services/srv_existing") && method === "PATCH") {
        return jsonResponse({ service: { id: "srv_existing" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const render = createRenderAdapter({ fetchImpl: fakeFetch, apiBase: "https://render.test/v1", pollIntervalMs: 1 });
    const result = await render.deploy({
      service,
      repo: { fullName: "acme/app", branch: "main" },
      rootDir: "",
      resourceName: "shipfix-run-api",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });
    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("srv_existing");
  });

  it("rejects non-node_api service types", async () => {
    const render = createRenderAdapter({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    const result = await render.deploy({
      service: { ...service, type: "frontend_static" },
      repo: { fullName: "a/b", branch: "main" },
      rootDir: "",
      env: {},
      credentials: { provider: "render", values: { apiKey: "k" } },
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toContain("node_api");
  });
});
