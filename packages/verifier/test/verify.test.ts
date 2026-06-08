import { describe, it, expect } from "vitest";
import {
  verifyHttpHealth,
  verifyFrontendLoads,
  verifyCorsFrom,
  verifyFromPlan,
  resolveHealthPath,
} from "../src/verify";
import type { DeploymentPlan } from "@shipfix/contracts";

describe("verifyHttpHealth", () => {
  it("passes on HTTP 200", async () => {
    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await verifyHttpHealth("https://api.example.com", "/health", { fetchImpl: fakeFetch });
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://api.example.com/health");
  });

  it("fails on non-2xx", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await verifyHttpHealth("https://api.example.com", "/", { fetchImpl: fakeFetch });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(503);
  });
});

describe("verifyFrontendLoads", () => {
  it("passes on HTML 200", async () => {
    const fakeFetch = (async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await verifyFrontendLoads("https://app.vercel.app", { fetchImpl: fakeFetch });
    expect(r.ok).toBe(true);
  });
});

describe("verifyCorsFrom", () => {
  it("passes when Allow-Origin matches frontend origin", async () => {
    const fakeFetch = (async () =>
      new Response("ok", {
        status: 200,
        headers: { "access-control-allow-origin": "https://app.vercel.app" },
      })) as unknown as typeof fetch;
    const r = await verifyCorsFrom(
      "https://api.onrender.com",
      "/health",
      "https://app.vercel.app",
      { fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(true);
  });

  it("fails when CORS header missing", async () => {
    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await verifyCorsFrom(
      "https://api.onrender.com",
      "/health",
      "https://app.vercel.app",
      { fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
  });
});

describe("verifyFromPlan", () => {
  const plan: DeploymentPlan = {
    goal: "x",
    classification: "deployable",
    services: [],
    managed: [],
    wiring: [],
    deployOrder: [],
    questions: [],
    blockers: [],
    verification: [
      { serviceId: "api", check: "health_path", target: "/health" },
      { serviceId: "web", check: "frontend_loads" },
      { serviceId: "api", check: "cors_from", target: "web" },
    ],
    confidence: 1,
  };

  it("runs plan verification checks against deployed resources", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("app.vercel.app")) {
        return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("ok", {
        status: 200,
        headers: { "access-control-allow-origin": "https://app.vercel.app" },
      });
    }) as unknown as typeof fetch;

    const outcomes = await verifyFromPlan(
      plan,
      [
        { serviceId: "api", publicUrl: "https://api.onrender.com" },
        { serviceId: "web", publicUrl: "https://app.vercel.app" },
      ],
      { fetchImpl: fakeFetch },
    );

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes).toHaveLength(3);
  });
});

describe("resolveHealthPath", () => {
  const plan: DeploymentPlan = {
    goal: "x",
    classification: "deployable",
    services: [],
    managed: [],
    wiring: [],
    deployOrder: [],
    questions: [],
    blockers: [],
    verification: [{ serviceId: "api", check: "health_path", target: "/health" }],
    confidence: 1,
  };

  it("uses plan verification target", () => {
    expect(resolveHealthPath(plan, "api", null).path).toBe("/health");
  });

  it("returns null path when plan omits target and healthCheckPath", () => {
    const bare: DeploymentPlan = {
      ...plan,
      verification: [{ serviceId: "api", check: "http_2xx" }],
    };
    expect(resolveHealthPath(bare, "api", null).path).toBeNull();
  });
});
