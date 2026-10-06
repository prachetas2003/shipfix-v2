/**
 * Helpers for running Drizzle migrations inside the sandbox after Neon provision.
 * Connection strings are passed only via exec env — never logged.
 */

import { migrateConnectionUrl, type NeonConnectionUrls } from "@shipfix/provisioner";
import type { Sandbox } from "@shipfix/sandbox";
import { installForMigration } from "./migrationInstall";

export function findDrizzleConfigPath(files: string[], preferredRootDir?: string): string | null {
  const configs = files.filter((f) => /(^|\/)drizzle\.config\.(ts|js|mjs|cjs)$/.test(f));
  if (configs.length === 0) return null;
  if (preferredRootDir) {
    const under = configs.find(
      (f) =>
        f === `${preferredRootDir}/drizzle.config.ts` ||
        f.startsWith(`${preferredRootDir}/`),
    );
    if (under) return under;
  }
  return configs[0] ?? null;
}

export function hasDrizzleMigrations(files: string[], configPath: string): boolean {
  const configDir = configPath.includes("/")
    ? configPath.slice(0, configPath.lastIndexOf("/"))
    : "";
  // Default drizzle-kit out dir is ./drizzle next to the config.
  const prefix = configDir ? `${configDir}/drizzle/` : "drizzle/";
  return files.some((f) => f.startsWith(prefix) && (f.endsWith(".sql") || f.includes("/meta/")));
}

export function drizzleMigrateCommand(packageManager: string): string {
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(packageManager) ? packageManager : "npm";
  if (pm === "pnpm") return "pnpm exec drizzle-kit migrate";
  if (pm === "yarn") return "yarn drizzle-kit migrate";
  if (pm === "bun") return "bunx drizzle-kit migrate";
  return "npx drizzle-kit migrate";
}

/** Schema sync for repos using the `drizzle-kit push` workflow (no migration files). */
export function drizzlePushCommand(packageManager: string): string {
  return drizzleMigrateCommand(packageManager).replace("drizzle-kit migrate", "drizzle-kit push --force");
}

export interface DrizzleMigrateResult {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  exitCode?: number;
  /** Redacted / truncated log tail — never includes connection strings. */
  detail: string;
}

/**
 * Bring the database schema up to date with the **direct** Neon URL:
 * `drizzle-kit migrate` when the repo ships migrations; otherwise
 * `drizzle-kit push --force`, but only on a database ShipFix just created
 * (empty, so nothing can be lost). A reused database without migrations is
 * left untouched rather than risk destructive schema changes.
 */
export async function runDrizzleMigrateDeploy(input: {
  sandbox: Sandbox;
  configPath: string;
  packageManager: string;
  urls: NeonConnectionUrls;
  /** True when the database was provisioned in this run (no existing data). */
  freshDatabase: boolean;
  timeoutMs?: number;
}): Promise<DrizzleMigrateResult> {
  const files = await input.sandbox.list();
  const hasMigrations = hasDrizzleMigrations(files, input.configPath);
  if (!hasMigrations && !input.freshDatabase) {
    return {
      ok: true,
      skipped: true,
      skipReason: "reused_database_without_migrations",
      detail: `Drizzle config found at ${input.configPath} but no drizzle/ migrations, and the database already holds data — not pushing schema changes automatically. Add migrations (drizzle-kit generate) to have ShipFix apply them safely.`,
    };
  }

  const install = await installForMigration({
    sandbox: input.sandbox,
    files,
    anchorPath: input.configPath,
    packageManager: input.packageManager,
  });
  if (!install.ok) return { ok: false, skipped: false, detail: redactConnectionStrings(install.detail) };

  const direct = migrateConnectionUrl(input.urls);
  const command = hasMigrations
    ? drizzleMigrateCommand(input.packageManager)
    : drizzlePushCommand(input.packageManager);
  const verb = hasMigrations ? "drizzle-kit migrate" : "drizzle-kit push";
  const cwd = input.configPath.includes("/")
    ? input.configPath.slice(0, input.configPath.lastIndexOf("/"))
    : ".";
  const result = await input.sandbox.exec(command, {
    timeoutMs: input.timeoutMs ?? 300_000,
    cwd: cwd === "." ? undefined : cwd,
    env: {
      DATABASE_URL: direct,
      CI: "1",
    },
  });

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const detail = redactConnectionStrings(combined).slice(0, 2000);

  if (result.timedOut) {
    return { ok: false, skipped: false, exitCode: result.exitCode, detail: `${verb} timed out. ${detail}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      exitCode: result.exitCode,
      detail: detail || `${verb} exited ${result.exitCode}`,
    };
  }
  return { ok: true, skipped: false, exitCode: 0, detail: detail || `${verb} succeeded.` };
}

function redactConnectionStrings(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, "postgres://[redacted]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[redacted]");
}
