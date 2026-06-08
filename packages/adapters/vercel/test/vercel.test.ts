import { describe, it, expect } from "vitest";
import type { PlanService } from "@shipfix/contracts";
import { createVercelAdapter } from "../src/index";

const service: PlanService = {
  id: "web",
  type: "frontend_static",
  provider: "vercel",
  rootDir: "apps/web",
  install: "npm install",
  build: "npm run build",
  start: null,
  outputDir: "dist",
  healthCheckPath: null,
  env: [],
  evidence: [],
};

const REPO_ID = "987654321";
const REPO_SLUG = "acme/app";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function linkedProject(projectId: string) {
  return jsonResponse({
    id: projectId,
    link: { type: "github", repo: REPO_SLUG, repoId: Number(REPO_ID) },
  });
}

describe("createVercelAdapter", () => {
  it("creates a project, resolves repoId, deploys from git with repoId, and waits for READY", async () => {
    let deployPolls = 0;
    let deploymentBody: Record<string, unknown> | null = null;

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_1", name: "shipfix-run-web" });
      }
      if (u.includes("/v10/projects/prj_1/env") && method === "POST") {
        return jsonResponse({ created: true });
      }
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return linkedProject("prj_1");
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        deploymentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET" && !u.includes("/env")) {
        deployPolls++;
        return jsonResponse({
          id: "dpl_1",
          readyState: deployPolls >= 2 ? "READY" : "BUILDING",
          url: "web-abc.vercel.app",
          alias: ["https://web-abc.vercel.app"],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://vercel.test",
      pollIntervalMs: 1,
      deployTimeoutMs: 5_000,
    });

    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main", commitSha: "abc123" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: { VITE_API_URL: "https://api.onrender.com" },
      credentials: { provider: "vercel", values: { apiToken: "vercel_test" } },
    });

    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("prj_1");
    expect(result.publicUrl).toBe("https://web-abc.vercel.app");
    expect(deploymentBody).not.toBeNull();
    const gitSource = deploymentBody!.gitSource as Record<string, string>;
    expect(gitSource.repoId).toBe(REPO_ID);
    expect(gitSource.ref).toBe("main");
    expect(gitSource.sha).toBe("abc123");
    expect(gitSource).not.toHaveProperty("repo");
  });

  it("updates an existing project by name and deploys with repoId from project link", async () => {
    let deploymentBody: Record<string, unknown> | null = null;

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [{ id: "prj_existing", name: "shipfix-run-web" }] });
      }
      if (u.includes("/v9/projects/prj_existing") && method === "PATCH") {
        return jsonResponse({ id: "prj_existing" });
      }
      if (u.includes("/v9/projects/prj_existing") && method === "GET") {
        return linkedProject("prj_existing");
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        deploymentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        return jsonResponse({ id: "dpl_1", readyState: "READY", alias: ["https://x.vercel.app"] });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });
    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("prj_existing");
    expect((deploymentBody!.gitSource as Record<string, string>).repoId).toBe(REPO_ID);
  });

  it("falls back to integrations search-repo when project link has no repoId", async () => {
    let deploymentPosted = false;
    let linkPosted = false;

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_new", name: "shipfix-run-web" });
      }
      if (u.includes("/v9/projects/prj_new/link") && method === "POST") {
        linkPosted = true;
        return jsonResponse({ id: "prj_new" });
      }
      if (u.includes("/v9/projects/prj_new") && method === "GET") {
        return jsonResponse({ id: "prj_new", link: { type: "github", org: "acme", repo: "app" } });
      }
      if (u.includes("/v1/integrations/search-repo") && method === "GET") {
        return jsonResponse({
          repos: [{ id: REPO_ID, owner: "acme", slug: "app" }],
        });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        deploymentPosted = true;
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        return jsonResponse({ id: "dpl_1", readyState: "READY", alias: ["https://x.vercel.app"] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(true);
    expect(linkPosted).toBe(false);
    expect(deploymentPosted).toBe(true);
  });

  it("links existing unlinked projects via POST /link with type and repo", async () => {
    let linkBody: Record<string, string> | null = null;

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [{ id: "prj_unlinked", name: "shipfix-run-web" }] });
      }
      if (u.includes("/v9/projects/prj_unlinked") && method === "PATCH") {
        return jsonResponse({ id: "prj_unlinked" });
      }
      if (u.includes("/v9/projects/prj_unlinked/link") && method === "POST") {
        linkBody = JSON.parse(String(init?.body)) as Record<string, string>;
        return jsonResponse({
          id: "prj_unlinked",
          link: { type: "github", org: "acme", repo: "app", repoId: Number(REPO_ID) },
        });
      }
      if (u.includes("/v9/projects/prj_unlinked") && method === "GET") {
        return jsonResponse({ id: "prj_unlinked" });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        return jsonResponse({ id: "dpl_1", readyState: "READY", alias: ["https://x.vercel.app"] });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(true);
    expect(linkBody).toEqual({ type: "github", repo: REPO_SLUG });
    expect(linkBody).not.toHaveProperty("gitRepository");
  });

  it("fails with setup_blocker when repoId cannot be resolved", async () => {
    let deploymentPosted = false;

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [{ id: "prj_orphan", name: "shipfix-run-web" }] });
      }
      if (u.includes("/v9/projects/prj_orphan") && method === "PATCH") {
        return jsonResponse({ id: "prj_orphan" });
      }
      if (u.includes("/v9/projects/prj_orphan/link") && method === "POST") {
        return jsonResponse({
          id: "prj_orphan",
          link: { type: "github", org: "other", repo: "repo" },
        });
      }
      if (u.includes("/v9/projects/prj_orphan") && method === "GET") {
        return jsonResponse({ id: "prj_orphan", link: { type: "github", org: "other", repo: "repo" } });
      }
      if (u.includes("/v1/integrations/search-repo") && method === "GET") {
        return jsonResponse({ repos: [] });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        deploymentPosted = true;
        return jsonResponse({ id: "dpl_1" });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("setup_blocker");
    expect(result.logs).toContain("repoId unresolved");
    expect(deploymentPosted).toBe(false);
    expect(result.publicUrl).toBeNull();
  });

  it("does not report live without a deployment URL", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_1", name: "shipfix-run-web" });
      }
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return linkedProject("prj_1");
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        return jsonResponse({ id: "dpl_1", readyState: "READY" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.publicUrl).toBeNull();
    expect(result.status).toBe("deploy_failed");
  });

  it("resolves the production URL from the project when the deployment alias lags", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_1", name: "shipfix-run-web" });
      }
      // Project GET: first call is repoId resolution (linked), later calls are
      // the production-URL fallback (targets.production.alias attached).
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return jsonResponse({
          id: "prj_1",
          link: { type: "github", repo: REPO_SLUG, repoId: Number(REPO_ID) },
          targets: { production: { alias: ["shipfix-run-web.vercel.app"] } },
        });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        // READY but no alias/url on the deployment snapshot yet.
        return jsonResponse({ id: "dpl_1", readyState: "READY" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("live");
    expect(result.publicUrl).toBe("https://shipfix-run-web.vercel.app");
  });

  it("uses the create-deployment url when the poll snapshot lacks a url", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_1", name: "shipfix-run-web" });
      }
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return linkedProject("prj_1");
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_1", url: "shipfix-run-web-abc.vercel.app" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        return jsonResponse({ id: "dpl_1", readyState: "READY" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({ fetchImpl: fakeFetch, apiBase: "https://vercel.test", pollIntervalMs: 1 });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(true);
    expect(result.publicUrl).toBe("https://shipfix-run-web-abc.vercel.app");
  });

  it("reconciles a READY deployment after the poll window times out", async () => {
    let deployGets = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";

      if (u.includes("/v9/projects?") && method === "GET") {
        return jsonResponse({ projects: [] });
      }
      if (u.endsWith("/v11/projects") && method === "POST") {
        return jsonResponse({ id: "prj_1", name: "shipfix-run-web" });
      }
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return jsonResponse({
          id: "prj_1",
          link: { type: "github", repo: REPO_SLUG, repoId: Number(REPO_ID) },
          targets: { production: { alias: ["shipfix-run-web.vercel.app"] } },
        });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_1" });
      }
      if (u.includes("/v13/deployments/dpl_1") && method === "GET") {
        deployGets++;
        // Stay BUILDING during the poll window; only the post-timeout
        // reconcile GET observes READY.
        return jsonResponse({ id: "dpl_1", readyState: deployGets >= 2 ? "READY" : "BUILDING" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://vercel.test",
      pollIntervalMs: 5,
      deployTimeoutMs: 1,
    });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(true);
    expect(result.publicUrl).toBe("https://shipfix-run-web.vercel.app");
  });

  it("returns timeout failure when the create-deployment HTTP request hangs", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v9/projects?")) return jsonResponse({ projects: [] });
      if (u.endsWith("/v11/projects") && method === "POST") return jsonResponse({ id: "prj_1" });
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return jsonResponse({
          id: "prj_1",
          link: { type: "github", repo: REPO_SLUG, repoId: Number(REPO_ID) },
        });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://vercel.test",
      httpTimeoutMs: 40,
      deployTimeoutMs: 5_000,
    });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.publicUrl).toBeNull();
    expect(result.status).toBe("timeout");
    expect(result.failureKind).toBe("timeout");
    expect(result.logs).toMatch(/timed out/i);
  });

  it("returns timeout failure when deployment polling exceeds deployTimeoutMs", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/v9/projects?")) return jsonResponse({ projects: [] });
      if (u.endsWith("/v11/projects") && method === "POST") return jsonResponse({ id: "prj_1" });
      if (u.includes("/v9/projects/prj_1") && method === "GET") {
        return jsonResponse({
          id: "prj_1",
          link: { type: "github", repo: REPO_SLUG, repoId: Number(REPO_ID) },
        });
      }
      if (u.endsWith("/v13/deployments") && method === "POST") {
        return jsonResponse({ id: "dpl_slow" });
      }
      if (u.includes("/v13/deployments/dpl_slow")) {
        return jsonResponse({ id: "dpl_slow", readyState: "BUILDING" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const vercel = createVercelAdapter({
      fetchImpl: fakeFetch,
      apiBase: "https://vercel.test",
      pollIntervalMs: 5,
      deployTimeoutMs: 30,
      httpTimeoutMs: 5_000,
    });
    const result = await vercel.deploy({
      service,
      repo: { fullName: REPO_SLUG, branch: "main" },
      rootDir: "apps/web",
      resourceName: "shipfix-run-web",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });

    expect(result.ok).toBe(false);
    expect(result.publicUrl).toBeNull();
    expect(result.status).toBe("timeout");
    expect(result.failureKind).toBe("timeout");
    expect(result.logs).toContain("Frontend deployment timed out on Vercel");
  });

  it("rejects non-frontend_static service types", async () => {
    const vercel = createVercelAdapter({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    const result = await vercel.deploy({
      service: { ...service, type: "node_api" },
      repo: { fullName: "a/b", branch: "main" },
      rootDir: "",
      env: {},
      credentials: { provider: "vercel", values: { apiToken: "k" } },
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toContain("frontend_static");
  });
});
