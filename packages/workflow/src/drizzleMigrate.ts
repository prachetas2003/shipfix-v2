/**
 * Helpers for running Drizzle migrations inside the sandbox after Neon provision.
 * Connection strings are passed only via exec env — never logged.
 */

import { migrateConnectionUrl, type NeonConnectionUrls } from "@shipfix/provisioner";
import type { Sandbox } from "@shipfix/sandbox";

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

export interface DrizzleMigrateResult {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  exitCode?: number;
  /** Redacted / truncated log tail — never includes connection strings. */
  detail: string;
}

/**
 * Run `drizzle-kit migrate` with the **direct** Neon URL.
 */
export async function runDrizzleMigrateDeploy(input: {
  sandbox: Sandbox;
  configPath: string;
  packageManager: string;
  urls: NeonConnectionUrls;
  timeoutMs?: number;
}): Promise<DrizzleMigrateResult> {
  const files = await input.sandbox.list();
  if (!hasDrizzleMigrations(files, input.configPath)) {
    return {
      ok: true,
      skipped: true,
      skipReason: "no_migrations_folder",
      detail: `Drizzle config found at ${input.configPath} but no drizzle/ migrations — skipping migrate.`,
    };
  }

  const direct = migrateConnectionUrl(input.urls);
  const command = drizzleMigrateCommand(input.packageManager);
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
    return { ok: false, skipped: false, exitCode: result.exitCode, detail: `drizzle-kit migrate timed out. ${detail}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      exitCode: result.exitCode,
      detail: detail || `drizzle-kit migrate exited ${result.exitCode}`,
    };
  }
  return { ok: true, skipped: false, exitCode: 0, detail: detail || "drizzle-kit migrate succeeded." };
}

function redactConnectionStrings(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, "postgres://[redacted]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[redacted]");
}
