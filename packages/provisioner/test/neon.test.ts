import { describe, it, expect, vi } from "vitest";
import type { ManagedService } from "@shipfix/contracts";
import { ProvisionerRegistry, createNeonProvisioner } from "../src/index";

const pgManaged: ManagedService = {
  id: "db",
  kind: "postgres",
  mode: "provision",
  provider: "neon",
  exposesEnv: "DATABASE_URL",
  migration: "none",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ProvisionerRegistry", () => {
  it("registers + resolves provisioners and reports support", () => {
    const reg = new ProvisionerRegistry();
    reg.register(createNeonProvisioner());
    expect(reg.has("neon")).toBe(true);
    expect(reg.get("neon")?.id).toBe("neon");
    expect(reg.ids()).toEqual(["neon"]);
    expect(reg.supports("neon", "postgres")).toBe(true);
    expect(reg.supports("neon", "redis")).toBe(false);
    expect(reg.supports("upstash", "redis")).toBe(false);
  });
});

describe("createNeonProvisioner", () => {
  it("creates a project and returns the connection URI as a secret exposed env", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        project: { id: "proj_123" },
        connection_uris: [{ connection_uri: "postgres://u:p@ep-x.neon.tech/db?sslmode=require" }],
      });
    }) as unknown as typeof fetch;

    const neon = createNeonProvisioner({ fetchImpl: fakeFetch, apiBase: "https://neon.test/v2" });
    const result = await neon.provision({
      resourceName: "shipfix-run-1-db",
      managed: pgManaged,
      credentials: { provider: "neon", values: { apiKey: "neon_key", orgId: "org_123" } },
    });

    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("proj_123");
    expect(result.host).toBe("ep-x.neon.tech");
    expect(result.exposed).toEqual({
      name: "DATABASE_URL",
      value: JSON.stringify({
        pooled: "postgres://u:p@ep-x.neon.tech/db?sslmode=require",
        direct: "postgres://u:p@ep-x.neon.tech/db?sslmode=require",
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://neon.test/v2/projects");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer neon_key");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      project: { name: "shipfix-run-1-db", org_id: "org_123" },
    });
  });

  it("selects pooled and direct URIs when both are present", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        project: { id: "proj_456" },
        connection_uris: [
          { connection_uri: "postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require" },
          { connection_uri: "postgres://u:p@ep-x.neon.tech/db?sslmode=require" },
        ],
      });
    }) as unknown as typeof fetch;

    const neon = createNeonProvisioner({ fetchImpl: fakeFetch, apiBase: "https://neon.test/v2" });
    const result = await neon.provision({
      resourceName: "shipfix-run-2-db",
      managed: pgManaged,
      credentials: { provider: "neon", values: { apiKey: "neon_key", orgId: "org_123" } },
    });

    expect(result.ok).toBe(true);
    expect(result.exposed?.value).toBe(
      JSON.stringify({
        pooled: "postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require",
        direct: "postgres://u:p@ep-x.neon.tech/db?sslmode=require",
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("fails cleanly on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const neon = createNeonProvisioner({ fetchImpl: fakeFetch });
    const result = await neon.provision({
      resourceName: "x",
      managed: pgManaged,
      credentials: { provider: "neon", values: { apiKey: "bad", orgId: "org_123" } },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.logs).toContain("401");
  });

  it("refuses a non-postgres kind", async () => {
    const neon = createNeonProvisioner({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    const result = await neon.provision({
      resourceName: "x",
      managed: { ...pgManaged, kind: "redis" },
      credentials: { provider: "neon", values: { apiKey: "k", orgId: "org_123" } },
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toContain("Postgres");
  });

  it("fails when the apiKey is missing", async () => {
    const neon = createNeonProvisioner({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    const result = await neon.provision({
      resourceName: "x",
      managed: pgManaged,
      credentials: { provider: "neon", values: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toContain("apiKey");
  });

  it("fails before calling Neon when the organization id is missing", async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const neon = createNeonProvisioner({ fetchImpl: fakeFetch });
    const logs: string[] = [];
    const result = await neon.provision({
      resourceName: "x",
      managed: pgManaged,
      credentials: { provider: "neon", values: { apiKey: "k" } },
      onLog: (line) => logs.push(line),
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toContain("NEON_ORG_ID");
    expect(logs).toContain("Neon organization ID available: false");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("fails cleanly when the Neon API request times out", async () => {
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const neon = createNeonProvisioner({ fetchImpl: fakeFetch, httpTimeoutMs: 20 });
    const result = await neon.provision({
      resourceName: "x",
      managed: pgManaged,
      credentials: { provider: "neon", values: { apiKey: "k", orgId: "org_123" } },
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toMatch(/timed out/i);
  });
});
