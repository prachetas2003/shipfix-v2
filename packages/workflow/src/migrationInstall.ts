/**
 * Migration CLIs (prisma, drizzle-kit) run from the repo's own node_modules so
 * the version the app was written against is the one that touches the schema.
 * A fresh sandbox clone has no node_modules, so install first.
 */

import type { Sandbox } from "@shipfix/sandbox";

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Where to run the install for a migration anchored at `anchorPath` (a
 * schema.prisma or drizzle.config): the workspace root for monorepos,
 * otherwise the nearest package.json at or above the anchor.
 */
export function migrationInstallDir(files: readonly string[], anchorPath: string): string {
  const set = new Set(files);
  if (set.has("pnpm-workspace.yaml") || set.has("lerna.json") || set.has("turbo.json")) return "";
  let dir = dirOf(anchorPath);
  for (;;) {
    if (set.has(dir ? `${dir}/package.json` : "package.json")) return dir;
    if (!dir) return "";
    dir = dirOf(dir);
  }
}

export function migrationInstallCommand(packageManager: string): string {
  if (packageManager === "pnpm") return "pnpm install --prefer-offline";
  if (packageManager === "yarn") return "yarn install";
  if (packageManager === "bun") return "bun install";
  return "npm install --no-audit --no-fund";
}

export interface InstallResult {
  ok: boolean;
  detail: string;
}

export async function installForMigration(input: {
  sandbox: Sandbox;
  files: readonly string[];
  anchorPath: string;
  packageManager: string;
  timeoutMs?: number;
}): Promise<InstallResult> {
  const cwd = migrationInstallDir(input.files, input.anchorPath);
  const result = await input.sandbox.exec(migrationInstallCommand(input.packageManager), {
    timeoutMs: input.timeoutMs ?? 600_000,
    cwd: cwd || undefined,
  });
  if (result.timedOut) return { ok: false, detail: "Dependency install timed out before migrating." };
  if (result.exitCode !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
    return { ok: false, detail: `Dependency install failed before migrating (exit ${result.exitCode}). ${tail}` };
  }
  return { ok: true, detail: "Dependencies installed." };
}
