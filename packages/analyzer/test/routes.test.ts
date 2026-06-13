import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  detectNextApiRoutes,
  extractRoutesFromSource,
  nextApiRoutePath,
  scoreRoutePath,
} from "../src/routes";
import { analyzeRepo, createLocalFsRepoSource } from "../src/index";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function analyzeFixture(name: string) {
  const source = createLocalFsRepoSource(path.join(FIXTURES, name));
  return analyzeRepo(source, {
    repoFullName: `fixtures/${name}`,
    commitSha: "0".repeat(40),
  });
}

describe("extractRoutesFromSource", () => {
  it("finds Express app.get routes", () => {
    const src = `
import express from "express";
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.send("hi"));
`;
    const routes = extractRoutesFromSource(src, "src/index.ts");
    expect(routes.some((r) => r.path === "/health" && r.method === "GET")).toBe(true);
    expect(routes.find((r) => r.path === "/health")?.score).toBeGreaterThan(
      routes.find((r) => r.path === "/")?.score ?? 0,
    );
  });

  it("finds router-mounted style routes", () => {
    const src = `router.get("/api/health", handler);`;
    const routes = extractRoutesFromSource(src, "src/routes.ts");
    expect(routes[0]?.path).toBe("/api/health");
  });

  it("finds Fastify route({ method, url })", () => {
    const src = `fastify.route({ method: 'GET', url: '/status', handler });`;
    const routes = extractRoutesFromSource(src, "src/server.ts");
    expect(routes[0]?.path).toBe("/status");
  });

  it("ignores template literal paths", () => {
    const src = `app.get(\`/users/\${id}\`, handler);`;
    expect(extractRoutesFromSource(src, "x.ts")).toHaveLength(0);
  });
});

describe("nextApiRoutePath", () => {
  it("maps pages router API files", () => {
    expect(nextApiRoutePath("pages/api/health.ts")).toBe("/api/health");
    expect(nextApiRoutePath("pages/api/todos/index.ts")).toBe("/api/todos");
    expect(nextApiRoutePath("src/pages/api/ping.js")).toBe("/api/ping");
  });

  it("maps app router route handlers", () => {
    expect(nextApiRoutePath("app/api/health/route.ts")).toBe("/api/health");
    expect(nextApiRoutePath("src/app/api/todos/route.js")).toBe("/api/todos");
    expect(nextApiRoutePath("app/(admin)/api/stats/route.ts")).toBe("/api/stats");
  });

  it("rejects dynamic segments and non-route files", () => {
    expect(nextApiRoutePath("pages/api/[id].ts")).toBeNull();
    expect(nextApiRoutePath("app/api/users/[id]/route.ts")).toBeNull();
    expect(nextApiRoutePath("app/page.tsx")).toBeNull();
    expect(nextApiRoutePath("pages/index.tsx")).toBeNull();
    expect(nextApiRoutePath("components/api/client.ts")).toBeNull();
  });
});

describe("detectNextApiRoutes", () => {
  it("collects routes under a service root and ranks health first", () => {
    const files = new Set([
      "package.json",
      "app/api/health/route.ts",
      "app/api/todos/route.ts",
      "app/page.tsx",
    ]);
    const routes = detectNextApiRoutes("", files);
    expect(routes.map((r) => r.path)).toEqual(["/api/health", "/api/todos"]);
    expect(routes.every((r) => r.kind === "inferred" && r.method === "GET")).toBe(true);
  });

  it("respects a nested rootDir", () => {
    const files = new Set(["apps/site/pages/api/health.ts", "apps/other/pages/api/x.ts"]);
    const routes = detectNextApiRoutes("apps/site", files);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/api/health");
    expect(routes[0]?.evidence).toEqual(["apps/site/pages/api/health.ts"]);
  });
});

describe("scoreRoutePath", () => {
  it("ranks health paths above root", () => {
    expect(scoreRoutePath("/health", "GET")).toBeGreaterThan(scoreRoutePath("/", "GET"));
  });
});

describe("express-backend fixture", () => {
  it("includes /health route candidate on api service", async () => {
    const ctx = await analyzeFixture("express-backend");
    const svc = ctx.services[0];
    expect(svc.routeCandidates.some((r) => r.path === "/health")).toBe(true);
    expect(svc.routeCandidates[0]?.path).toBe("/health");
  });
});
