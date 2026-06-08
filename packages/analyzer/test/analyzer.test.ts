import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { RepoContext } from "@shipfix/contracts";
import { analyzeRepo, createLocalFsRepoSource } from "../src/index";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function analyzeFixture(name: string) {
  const source = createLocalFsRepoSource(path.join(FIXTURES, name));
  return analyzeRepo(source, {
    repoFullName: `fixtures/${name}`,
    commitSha: "0".repeat(40),
  });
}

describe("analyzer: output always validates against the RepoContext schema", () => {
  const fixtures = [
    "vite-frontend",
    "express-backend",
    "vite-express-split",
    "next-app",
    "fastapi-app",
    "docker-only",
    "docker-compose-only",
    "prisma-postgres",
    "pnpm-workspace",
    "hardcoded-localhost",
  ];

  for (const name of fixtures) {
    it(`${name} -> valid RepoContext`, async () => {
      const ctx = await analyzeFixture(name);
      expect(() => RepoContext.parse(ctx)).not.toThrow();
      expect(ctx.repoFullName).toBe(`fixtures/${name}`);
      expect(ctx.commitSha).toHaveLength(40);
      expect(ctx.fileTree.length).toBeGreaterThan(0);
    });
  }
});

describe("vite-frontend", () => {
  it("detects a single Vite frontend on npm", async () => {
    const ctx = await analyzeFixture("vite-frontend");
    expect(ctx.services).toHaveLength(1);
    const [svc] = ctx.services;
    expect(svc.framework).toBe("vite");
    expect(svc.role).toBe("frontend");
    expect(svc.language).toBe("node");
    expect(svc.packageManager).toBe("npm");
    expect(svc.rootDir).toBe("");
    expect(svc.entrypoints).toContain("src/main.tsx");
  });

  it("captures the VITE_ env ref (import.meta.env), names only", async () => {
    const ctx = await analyzeFixture("vite-frontend");
    expect(ctx.envRefs.map((e) => e.name)).toContain("VITE_API_URL");
  });

  it("has no data needs and no hardcoded URLs", async () => {
    const ctx = await analyzeFixture("vite-frontend");
    expect(ctx.dataNeeds).toHaveLength(0);
    expect(ctx.hardcodedUrls).toHaveLength(0);
  });
});

describe("express-backend", () => {
  it("detects an Express backend on yarn", async () => {
    const ctx = await analyzeFixture("express-backend");
    expect(ctx.services).toHaveLength(1);
    const [svc] = ctx.services;
    expect(svc.framework).toBe("express");
    expect(svc.role).toBe("backend");
    expect(svc.packageManager).toBe("yarn");
    expect(svc.scripts.start).toBe("node src/index.js");
    expect(svc.entrypoints).toContain("src/index.js");
  });

  it("references PORT and has no database need", async () => {
    const ctx = await analyzeFixture("express-backend");
    expect(ctx.envRefs.map((e) => e.name)).toContain("PORT");
    expect(ctx.dataNeeds).toHaveLength(0);
  });
});

describe("vite-express-split", () => {
  it("detects two services (frontend + backend), skipping the workspace root", async () => {
    const ctx = await analyzeFixture("vite-express-split");
    expect(ctx.services).toHaveLength(2);
    const byRole = Object.fromEntries(ctx.services.map((s) => [s.role, s]));
    expect(byRole.frontend.rootDir).toBe("web");
    expect(byRole.frontend.framework).toBe("vite");
    expect(byRole.backend.rootDir).toBe("server");
    expect(byRole.backend.framework).toBe("express");
    // workspaces-only root is not itself a deployable service
    expect(ctx.services.some((s) => s.rootDir === "")).toBe(false);
  });

  it("flags the hardcoded localhost URL in the frontend", async () => {
    const ctx = await analyzeFixture("vite-express-split");
    const hit = ctx.hardcodedUrls.find((u) => u.value.includes("localhost:3001"));
    expect(hit).toBeDefined();
    expect(hit?.service).toBe("web");
    expect(hit?.file).toBe("web/src/api.ts");
  });

  it("uses the root npm lockfile for both services", async () => {
    const ctx = await analyzeFixture("vite-express-split");
    expect(ctx.services.every((s) => s.packageManager === "npm")).toBe(true);
  });
});

describe("next-app", () => {
  it("detects Next.js as fullstack on pnpm", async () => {
    const ctx = await analyzeFixture("next-app");
    expect(ctx.services).toHaveLength(1);
    const [svc] = ctx.services;
    expect(svc.framework).toBe("next");
    expect(svc.role).toBe("fullstack");
    expect(svc.packageManager).toBe("pnpm");
    expect(ctx.monorepoTool).toBe("none");
  });

  it("captures NEXT_PUBLIC_ env ref", async () => {
    const ctx = await analyzeFixture("next-app");
    expect(ctx.envRefs.map((e) => e.name)).toContain("NEXT_PUBLIC_API_URL");
  });
});

describe("unsupported repo signals", () => {
  it("detects FastAPI/Python as an unsupported backend signal", async () => {
    const ctx = await analyzeFixture("fastapi-app");
    expect(ctx.services).toHaveLength(1);
    expect(ctx.services[0]).toMatchObject({
      language: "python",
      framework: "fastapi",
      role: "backend",
      packageManager: "pip",
    });
  });

  it("detects Dockerfile-only repos instead of returning no services", async () => {
    const ctx = await analyzeFixture("docker-only");
    expect(ctx.services).toHaveLength(1);
    expect(ctx.services[0]).toMatchObject({
      language: "docker",
      framework: "docker",
      hasDockerfile: true,
    });
  });

  it("detects docker-compose-only repos instead of returning no services", async () => {
    const ctx = await analyzeFixture("docker-compose-only");
    expect(ctx.services).toHaveLength(1);
    expect(ctx.services[0]).toMatchObject({
      language: "docker",
      framework: "docker-compose",
    });
  });
});

describe("prisma-postgres", () => {
  it("detects a Postgres need via Prisma (with migration tool) on bun", async () => {
    const ctx = await analyzeFixture("prisma-postgres");
    const [svc] = ctx.services;
    expect(svc.packageManager).toBe("bun");

    const pg = ctx.dataNeeds.find((d) => d.kind === "postgres");
    expect(pg).toBeDefined();
    expect(pg?.detectedFrom).toBe("prisma");
    expect(pg?.migrationTool).toBe("prisma");
  });

  it("does not emit a separate sqlite/mysql need", async () => {
    const ctx = await analyzeFixture("prisma-postgres");
    expect(ctx.dataNeeds).toHaveLength(1);
  });
});

describe("pnpm-workspace", () => {
  it("reports the pnpm_workspace monorepo signal", async () => {
    const ctx = await analyzeFixture("pnpm-workspace");
    expect(ctx.monorepoTool).toBe("pnpm_workspace");
  });

  it("detects the two child packages and skips the workspace manager root", async () => {
    const ctx = await analyzeFixture("pnpm-workspace");
    const roots = ctx.services.map((s) => s.rootDir).sort();
    expect(roots).toEqual(["packages/api", "packages/web"]);
    const api = ctx.services.find((s) => s.rootDir === "packages/api");
    const web = ctx.services.find((s) => s.rootDir === "packages/web");
    expect(api?.framework).toBe("fastify");
    expect(api?.role).toBe("backend");
    expect(web?.framework).toBe("vite");
    expect(web?.role).toBe("frontend");
    expect(ctx.services.every((s) => s.packageManager === "pnpm")).toBe(true);
  });
});

describe("hardcoded-localhost", () => {
  it("flags every hardcoded local URL", async () => {
    const ctx = await analyzeFixture("hardcoded-localhost");
    const values = ctx.hardcodedUrls.map((u) => u.value);
    expect(values).toContain("http://localhost:4000/api");
    expect(values).toContain("ws://localhost:4001");
    expect(values).toContain("http://127.0.0.1:5432");
    expect(ctx.hardcodedUrls.length).toBeGreaterThanOrEqual(3);
  });
});
