import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { extractRoutesFromSource, scoreRoutePath } from "../src/routes";
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
