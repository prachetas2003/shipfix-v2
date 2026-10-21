import { describe, expect, it } from "vitest";
import { analyzeRepo } from "../src/index";
import { readinessScore } from "../src/security";

function repo(files: Record<string, string>) {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (p: string) => files[p] ?? null,
  };
}

const SECRET = "sk_live_" + "a".repeat(20);

async function scan(files: Record<string, string>) {
  return analyzeRepo(repo(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
}

describe("launch readiness", () => {
  it("scores a clean backend at 100 and does not claim to have scanned git history", async () => {
    const ctx = await scan({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "4.19.2" } }),
      "server.js": "const express = require('express');",
    });
    expect(ctx.security?.score).toBe(100);
    expect(ctx.security?.findings).toEqual([]);
    expect(ctx.security?.historyScanned).toBe(false);
  });

  it("reports a committed key without copying the key into the report", async () => {
    const ctx = await scan({ "src/pay.ts": `const key = "${SECRET}";` });
    const report = JSON.stringify(ctx.security);
    expect(report).not.toContain(SECRET);
    expect(ctx.security?.findings.map((f) => f.code)).toContain("committed_secret");
    expect(ctx.security?.findings[0]?.file).toBe("src/pay.ts");
  });

  it("flags a service-role key in frontend code and a public table without row security", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    const jwt = `${header}.${body}.signature`;
    const ctx = await scan({
      "web/package.json": JSON.stringify({
        scripts: { build: "vite build" },
        dependencies: { react: "19", "react-dom": "19" },
        devDependencies: { vite: "7" },
      }),
      "web/package-lock.json": "{}",
      "web/src/main.tsx": `const key = "${jwt}";`,
      "supabase/migrations/20240101000000_init.sql": "create table public.notes (id int);",
    });
    const codes = ctx.security?.findings.map((f) => f.code) ?? [];
    expect(codes).toContain("client_secret");
    expect(codes).toContain("rls_disabled");
    expect(JSON.stringify(ctx.security)).not.toContain(jwt);
  });

  it("flags a policy that allows everyone and a known-bad dependency", async () => {
    const ctx = await scan({
      "package.json": JSON.stringify({ dependencies: { "event-stream": "3.3.6" } }),
      "supabase/migrations/20240101000000_open.sql":
        "create table public.notes (id int); alter table public.notes enable row level security; create policy open on public.notes for all using (true);",
    });
    const codes = ctx.security?.findings.map((f) => f.code) ?? [];
    expect(codes).toContain("rls_policy_true");
    expect(codes).toContain("known_bad_dependency");
    expect(codes).not.toContain("rls_disabled");
  });

  it("asks for headers on a frontend and skips them when they already exist", async () => {
    const bare = await scan({
      "package.json": JSON.stringify({
        scripts: { build: "vite build" },
        dependencies: { react: "19" },
        devDependencies: { vite: "7" },
      }),
      "package-lock.json": "{}",
      "src/main.tsx": "export const App = () => null;",
    });
    expect(bare.security?.findings.some((f) => f.code === "missing_headers" && f.fixable)).toBe(true);

    const covered = await scan({
      "package.json": JSON.stringify({
        scripts: { build: "vite build" },
        dependencies: { react: "19" },
        devDependencies: { vite: "7" },
      }),
      "package-lock.json": "{}",
      "src/main.tsx": "export const App = () => null;",
      "vercel.json": JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }] }),
    });
    expect(covered.security?.findings.some((f) => f.code === "missing_headers")).toBe(false);
  });

  it("drops 25 points per high finding", () => {
    expect(readinessScore([{ severity: "high" }, { severity: "medium" }])).toBe(65);
  });
});
