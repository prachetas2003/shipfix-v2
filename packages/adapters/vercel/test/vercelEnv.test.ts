import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERCEL_ENV_TARGETS,
  envVarMatches,
  isDuplicateEnvVarError,
  targetsMatch,
  type VercelEnvVar,
} from "../src/vercelEnv";

describe("vercel env matching", () => {
  const row: VercelEnvVar = {
    id: "env_1",
    key: "VITE_API_URL",
    target: ["production", "preview"],
    gitBranch: null,
  };

  it("matches key, targets, and branch", () => {
    expect(envVarMatches(row, "VITE_API_URL", DEFAULT_VERCEL_ENV_TARGETS)).toBe(true);
    expect(envVarMatches(row, "OTHER", DEFAULT_VERCEL_ENV_TARGETS)).toBe(false);
    expect(envVarMatches({ ...row, target: ["production"] }, "VITE_API_URL", DEFAULT_VERCEL_ENV_TARGETS)).toBe(
      false,
    );
  });

  it("detects duplicate env var API errors", () => {
    expect(
      isDuplicateEnvVarError(
        "A variable with the name `VITE_API_URL` already exists for the target production,preview on branch undefined",
      ),
    ).toBe(true);
  });

  it("compares target sets regardless of order", () => {
    expect(targetsMatch(["preview", "production"], DEFAULT_VERCEL_ENV_TARGETS)).toBe(true);
  });
});

describe("upsertProjectEnvVar", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("creates VITE_API_URL when none exists", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u}`);
      if (u.includes("/v10/projects/prj_1/env") && method === "GET") {
        return jsonResponse({ envs: [] });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { key: string; value: string };
        expect(body.key).toBe("VITE_API_URL");
        expect(body.value).toBe("https://api.onrender.com");
        return jsonResponse({ created: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { upsertProjectEnvVar } = await import("../src/vercelEnv");
    const logs: string[] = [];
    await upsertProjectEnvVar(
      fakeFetch,
      "https://vercel.test",
      "token",
      undefined,
      5_000,
      "prj_1",
      "VITE_API_URL",
      "https://api.onrender.com",
      (line) => logs.push(line),
    );

    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(logs).toContain("Vercel: env var VITE_API_URL updated");
  });

  it("replaces an existing VITE_API_URL before create", async () => {
    let createCount = 0;
    let deleteCount = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v10/projects/prj_1/env/env_old") && method === "DELETE") {
        deleteCount++;
        return jsonResponse({ deleted: true });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "GET") {
        return jsonResponse({
          envs: [{ id: "env_old", key: "VITE_API_URL", target: ["production", "preview"], gitBranch: null }],
        });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "POST") {
        createCount++;
        return jsonResponse({ created: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { upsertProjectEnvVar } = await import("../src/vercelEnv");
    const logs: string[] = [];
    await upsertProjectEnvVar(
      fakeFetch,
      "https://vercel.test",
      "token",
      undefined,
      5_000,
      "prj_1",
      "VITE_API_URL",
      "https://api-new.onrender.com",
      (line) => logs.push(line),
    );

    expect(deleteCount).toBe(1);
    expect(createCount).toBe(1);
    expect(logs).toContain("Vercel: env var exists, replacing VITE_API_URL");
    expect(logs).toContain("Vercel: env var VITE_API_URL updated");
  });

  it("retries after duplicate HTTP 400 by deleting and recreating", async () => {
    let createAttempts = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v10/projects/prj_1/env/env_dup") && method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "GET") {
        return jsonResponse({
          envs:
            createAttempts >= 1
              ? [{ id: "env_dup", key: "VITE_API_URL", target: ["production", "preview"], gitBranch: null }]
              : [],
        });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "POST") {
        createAttempts++;
        if (createAttempts === 1) {
          return jsonResponse(
            {
              error: {
                code: "bad_request",
                message:
                  "A variable with the name `VITE_API_URL` already exists for the target production,preview on branch undefined",
              },
            },
            400,
          );
        }
        return jsonResponse({ created: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { upsertProjectEnvVar } = await import("../src/vercelEnv");
    await upsertProjectEnvVar(
      fakeFetch,
      "https://vercel.test",
      "token",
      undefined,
      5_000,
      "prj_1",
      "VITE_API_URL",
      "https://api.onrender.com",
    );

    expect(createAttempts).toBe(2);
  });

  it("throws provider_env_conflict when duplicate persists after retry", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v10/projects/prj_1/env") && method === "GET") {
        return jsonResponse({
          envs: [{ id: "env_dup", key: "VITE_API_URL", target: ["production", "preview"], gitBranch: null }],
        });
      }
      if (u.includes("/v10/projects/prj_1/env/env_dup") && method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "POST") {
        return jsonResponse(
          {
            error: {
              code: "bad_request",
              message:
                "A variable with the name `VITE_API_URL` already exists for the target production,preview on branch undefined",
            },
          },
          400,
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { upsertProjectEnvVar, VercelEnvConflictError } = await import("../src/vercelEnv");
    await expect(
      upsertProjectEnvVar(fakeFetch, "https://vercel.test", "token", undefined, 5_000, "prj_1", "VITE_API_URL", "x"),
    ).rejects.toBeInstanceOf(VercelEnvConflictError);
  });
});
