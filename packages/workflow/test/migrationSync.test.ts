import { describe, expect, it } from "vitest";
import type { Sandbox } from "@shipfix/sandbox";
import { drizzlePushCommand, runDrizzleMigrateDeploy } from "../src/drizzleMigrate";
import { migrationInstallCommand, migrationInstallDir } from "../src/migrationInstall";
import { prismaPushCommand, runPrismaMigrateDeploy } from "../src/prismaMigrate";

const URLS = {
  pooled: "postgres://u:secretpw@ep-pool.neon.tech/db",
  direct: "postgres://u:secretpw@ep-direct.neon.tech/db",
  singleUri: false,
};

function fakeSandbox(files: string[], exitCodes: Record<string, number> = {}) {
  const calls: { cmd: string; cwd?: string; env?: Record<string, string> }[] = [];
  const sandbox = {
    list: async () => files,
    exec: async (cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}) => {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env });
      const key = Object.keys(exitCodes).find((k) => cmd.includes(k));
      const exitCode = key ? exitCodes[key] : 0;
      return { exitCode, stdout: exitCode ? `failed using ${URLS.direct}` : "", stderr: "", timedOut: false };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

const REPLIT_FILES = [
  "pnpm-workspace.yaml",
  "package.json",
  "artifacts/api-server/package.json",
  "lib/db/package.json",
  "lib/db/drizzle.config.ts",
];

describe("migration dependency install", () => {
  it("installs at the workspace root for monorepos and next to the schema otherwise", () => {
    expect(migrationInstallDir(REPLIT_FILES, "lib/db/drizzle.config.ts")).toBe("");
    expect(migrationInstallDir(["server/package.json", "server/prisma/schema.prisma"], "server/prisma/schema.prisma")).toBe(
      "server",
    );
    expect(migrationInstallDir(["package.json", "prisma/schema.prisma"], "prisma/schema.prisma")).toBe("");
    expect(migrationInstallCommand("pnpm")).toMatch(/^pnpm install/);
  });
});

describe("drizzle schema sync", () => {
  it("installs deps then pushes the schema to a fresh database when there are no migrations", async () => {
    const { sandbox, calls } = fakeSandbox(REPLIT_FILES);
    const r = await runDrizzleMigrateDeploy({
      sandbox,
      configPath: "lib/db/drizzle.config.ts",
      packageManager: "pnpm",
      urls: URLS,
      freshDatabase: true,
    });
    expect(r).toMatchObject({ ok: true, skipped: false });
    expect(calls.map((c) => c.cmd)).toEqual(["pnpm install --prefer-offline", drizzlePushCommand("pnpm")]);
    expect(calls[1]).toMatchObject({ cwd: "lib/db", env: { DATABASE_URL: URLS.direct } });
  });

  it("never force-pushes into a reused database", async () => {
    const { sandbox, calls } = fakeSandbox(REPLIT_FILES);
    const r = await runDrizzleMigrateDeploy({
      sandbox,
      configPath: "lib/db/drizzle.config.ts",
      packageManager: "pnpm",
      urls: URLS,
      freshDatabase: false,
    });
    expect(r).toMatchObject({ ok: true, skipped: true, skipReason: "reused_database_without_migrations" });
    expect(calls).toEqual([]);
  });

  it("runs migrate (not push) when migrations exist, even on a reused database", async () => {
    const { sandbox, calls } = fakeSandbox([...REPLIT_FILES, "lib/db/drizzle/0000_init.sql"]);
    await runDrizzleMigrateDeploy({
      sandbox,
      configPath: "lib/db/drizzle.config.ts",
      packageManager: "pnpm",
      urls: URLS,
      freshDatabase: false,
    });
    expect(calls[1].cmd).toBe("pnpm exec drizzle-kit migrate");
  });

  it("reports install failures without running the migration", async () => {
    const { sandbox, calls } = fakeSandbox(REPLIT_FILES, { "pnpm install": 1 });
    const r = await runDrizzleMigrateDeploy({
      sandbox,
      configPath: "lib/db/drizzle.config.ts",
      packageManager: "pnpm",
      urls: URLS,
      freshDatabase: true,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Dependency install failed");
    expect(r.detail).not.toContain("secretpw");
    expect(calls).toHaveLength(1);
  });
});

describe("prisma schema sync", () => {
  const files = ["package.json", "prisma/schema.prisma"];

  it("uses db push on a fresh database without migrations", async () => {
    const { sandbox, calls } = fakeSandbox(files);
    const r = await runPrismaMigrateDeploy({
      sandbox,
      schemaPath: "prisma/schema.prisma",
      packageManager: "npm",
      urls: URLS,
      freshDatabase: true,
    });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "npm install --no-audit --no-fund",
      prismaPushCommand("prisma/schema.prisma", "npm"),
    ]);
    expect(calls[1].cmd).toContain("prisma db push --accept-data-loss --schema prisma/schema.prisma");
    expect(calls[1].cwd).toBeUndefined();
  });

  it("runs the Prisma installed beside a nested schema, not a copy from the repo root", async () => {
    const nested = [
      "api/package.json",
      "api/prisma/schema.prisma",
      "api/prisma/migrations/20261022000000_init/migration.sql",
      "web/package.json",
    ];
    const { sandbox, calls } = fakeSandbox(nested);
    const r = await runPrismaMigrateDeploy({
      sandbox,
      schemaPath: "api/prisma/schema.prisma",
      packageManager: "npm",
      urls: URLS,
      freshDatabase: true,
    });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ cmd: "npm install --no-audit --no-fund", cwd: "api" });
    expect(calls[1].cmd).toBe("npx prisma migrate deploy --schema prisma/schema.prisma");
    expect(calls[1].cwd).toBe("api");
  });

  it("sets a JavaScript Prisma config aside so migrate uses the schema URL", async () => {
    const nested = [
      "api/package.json",
      "api/prisma.config.ts",
      "api/prisma/schema.prisma",
      "api/prisma/migrations/20261022000000_init/migration.sql",
    ];
    const { sandbox, calls } = fakeSandbox(nested);
    const r = await runPrismaMigrateDeploy({
      sandbox,
      schemaPath: "api/prisma/schema.prisma",
      packageManager: "npm",
      urls: URLS,
      freshDatabase: true,
    });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "npm install --no-audit --no-fund",
      "mv prisma.config.ts prisma.config.ts.shipfix-bak",
      "npx prisma migrate deploy --schema prisma/schema.prisma",
      "mv prisma.config.ts.shipfix-bak prisma.config.ts",
    ]);
    expect(calls[2].cwd).toBe("api");
  });

  it("skips a reused database without migrations and redacts failures", async () => {
    const reused = fakeSandbox(files);
    const skipped = await runPrismaMigrateDeploy({
      sandbox: reused.sandbox,
      schemaPath: "prisma/schema.prisma",
      packageManager: "npm",
      urls: URLS,
      freshDatabase: false,
    });
    expect(skipped.skipReason).toBe("reused_database_without_migrations");

    const failing = fakeSandbox([...files, "prisma/migrations/1_init/migration.sql"], { "migrate deploy": 1 });
    const failed = await runPrismaMigrateDeploy({
      sandbox: failing.sandbox,
      schemaPath: "prisma/schema.prisma",
      packageManager: "npm",
      urls: URLS,
      freshDatabase: false,
    });
    expect(failed.ok).toBe(false);
    expect(failed.detail).not.toContain("secretpw");
  });
});
