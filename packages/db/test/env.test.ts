import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseFingerprint, effectiveTemporalTaskQueue, loadShipfixEnv } from "../src/env";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("@shipfix/db env helpers", () => {
  it("redacts database fingerprints without credentials", () => {
    const fp = databaseFingerprint("postgres://user:secret@ep-cool-name.us-east-2.aws.neon.tech:5432/shipfix_dev?sslmode=require");
    expect(fp.databaseUrlPresent).toBe(true);
    expect(fp.databaseName).toBe("shipfix_dev");
    expect(fp.hostRedacted).toMatch(/^ep-c/);
    expect(fp.hostRedacted).not.toContain("secret");
    expect(fp.hostHash).toHaveLength(12);
    expect(JSON.stringify(fp)).not.toContain("secret");
    expect(JSON.stringify(fp)).not.toContain("user");
  });

  it("reports missing DATABASE_URL", () => {
    expect(databaseFingerprint(undefined)).toEqual({
      databaseUrlPresent: false,
      hostHash: null,
      hostRedacted: null,
      databaseName: null,
    });
  });

  it("loads repo-root .env before app-local overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipfix-env-"));
    const rootEnv = join(dir, ".env");
    const appDir = join(dir, "apps", "api");
    const appLocal = join(appDir, ".env.local");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(rootEnv, "DATABASE_URL=postgres://localhost:5432/rootdb\n");
    writeFileSync(appLocal, "DATABASE_URL=postgres://localhost:5432/overridedb\n");

    const loaded = loadShipfixEnv({ rootEnvPath: rootEnv, appLocalEnvPath: appLocal });
    expect(loaded.envSourcePath).toContain("repo-root/.env");
    expect(loaded.envSourcePath).toContain("app/.env.local");
    expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/overridedb");
  });

  it("can let repo-root .env override stale shell env in local dev", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipfix-env-"));
    const rootEnv = join(dir, ".env");
    const appDir = join(dir, "apps", "worker");
    const appLocal = join(appDir, ".env.local");
    mkdirSync(appDir, { recursive: true });
    process.env.DATABASE_URL = "postgres://localhost:5432/stale_shell_db";
    writeFileSync(rootEnv, "DATABASE_URL=postgres://localhost:5432/rootdb\n");

    const loaded = loadShipfixEnv({
      rootEnvPath: rootEnv,
      appLocalEnvPath: appLocal,
      rootOverride: true,
    });

    expect(loaded.rootEnvOverride).toBe(true);
    expect(process.env.DATABASE_URL).toBe("postgres://localhost:5432/rootdb");
  });

  it("keeps production task queue explicit but scopes generic dev queue to the database", () => {
    const url = "postgres://shipfix:secret@ep-control.us-east-2.aws.neon.tech:5432/neondb";
    const devQueue = effectiveTemporalTaskQueue("shipfix", url, "development");
    expect(devQueue).toMatch(/^shipfix-[0-9a-f]{12}$/);
    expect(devQueue).not.toBe("shipfix");
    expect(effectiveTemporalTaskQueue("custom-queue", url, "development")).toBe("custom-queue");
    expect(effectiveTemporalTaskQueue("shipfix", url, "production")).toBe("shipfix");
  });

  it("keeps drizzle config free of unsafe local DATABASE_URL fallbacks", () => {
    const config = readFileSync(new URL("../drizzle.config.ts", import.meta.url), "utf8");
    expect(config).not.toContain("postgres://shipfix:shipfix@localhost:5432/shipfix");
    expect(config).not.toMatch(/DATABASE_URL\s*\?\?/);
  });
});
