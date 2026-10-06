/**
 * Helpers for running Prisma migrations inside the sandbox after Neon provision.
 * Connection strings are passed only via exec env — never logged.
 */

import { migrateConnectionUrl, type NeonConnectionUrls } from "@shipfix/provisioner";
import type { Sandbox } from "@shipfix/sandbox";
import { installForMigration } from "./migrationInstall";

export function findPrismaSchemaPath(files: string[], preferredRootDir?: string): string | null {
  const schemas = files.filter((f) => /(^|\/)schema\.prisma$/.test(f));
  if (schemas.length === 0) return null;
  if (preferredRootDir) {
    const under = schemas.find(
      (f) => f === `${preferredRootDir}/schema.prisma` || f.startsWith(`${preferredRootDir}/`),
    );
    if (under) return under;
  }
  // Prefer prisma/schema.prisma style paths.
  const conventional = schemas.find((f) => /(^|\/)prisma\/schema\.prisma$/.test(f));
  return conventional ?? schemas[0] ?? null;
}

export function hasPrismaMigrations(files: string[], schemaPath: string): boolean {
  const schemaDir = schemaPath.includes("/")
    ? schemaPath.slice(0, schemaPath.lastIndexOf("/"))
    : "";
  // Typical layout: prisma/schema.prisma + prisma/migrations/...
  const migrationsPrefix = schemaDir ? `${schemaDir}/migrations/` : "migrations/";
  return files.some((f) => f.startsWith(migrationsPrefix));
}

export function prismaMigrateCommand(schemaPath: string, packageManager: string): string {
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(packageManager) ? packageManager : "npm";
  const schemaFlag = `--schema ${schemaPath}`;
  if (pm === "pnpm") return `pnpm exec prisma migrate deploy ${schemaFlag}`;
  if (pm === "yarn") return `yarn prisma migrate deploy ${schemaFlag}`;
  if (pm === "bun") return `bunx prisma migrate deploy ${schemaFlag}`;
  return `npx prisma migrate deploy ${schemaFlag}`;
}

/** Schema sync for repos using the `prisma db push` workflow (no migrations folder). */
export function prismaPushCommand(schemaPath: string, packageManager: string): string {
  return prismaMigrateCommand(schemaPath, packageManager).replace(
    "prisma migrate deploy",
    "prisma db push --accept-data-loss",
  );
}

export interface PrismaMigrateResult {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  exitCode?: number;
  /** Redacted / truncated log tail — never includes connection strings. */
  detail: string;
}

/**
 * Bring the database schema up to date with the **direct** Neon URL (both
 * DATABASE_URL and DIRECT_URL): `prisma migrate deploy` when the repo ships
 * migrations; otherwise `prisma db push`, but only on a database ShipFix just
 * created (empty, so nothing can be lost). A reused database without
 * migrations is left untouched rather than risk destructive schema changes.
 */
export async function runPrismaMigrateDeploy(input: {
  sandbox: Sandbox;
  schemaPath: string;
  packageManager: string;
  urls: NeonConnectionUrls;
  /** True when the database was provisioned in this run (no existing data). */
  freshDatabase: boolean;
  timeoutMs?: number;
}): Promise<PrismaMigrateResult> {
  const files = await input.sandbox.list();
  const hasMigrations = hasPrismaMigrations(files, input.schemaPath);
  if (!hasMigrations && !input.freshDatabase) {
    return {
      ok: true,
      skipped: true,
      skipReason: "reused_database_without_migrations",
      detail: `Prisma schema found at ${input.schemaPath} but no migrations folder, and the database already holds data — not pushing schema changes automatically. Add migrations (prisma migrate dev) to have ShipFix apply them safely.`,
    };
  }

  const install = await installForMigration({
    sandbox: input.sandbox,
    files,
    anchorPath: input.schemaPath,
    packageManager: input.packageManager,
  });
  if (!install.ok) return { ok: false, skipped: false, detail: redactConnectionStrings(install.detail) };

  const direct = migrateConnectionUrl(input.urls);
  const command = hasMigrations
    ? prismaMigrateCommand(input.schemaPath, input.packageManager)
    : prismaPushCommand(input.schemaPath, input.packageManager);
  const verb = hasMigrations ? "prisma migrate deploy" : "prisma db push";
  const result = await input.sandbox.exec(command, {
    timeoutMs: input.timeoutMs ?? 300_000,
    env: {
      // Migrate must use the direct (non-pooler) URL.
      DATABASE_URL: direct,
      DIRECT_URL: direct,
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
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[redacted]")
    .replace(/DIRECT_URL=[^\s]+/gi, "DIRECT_URL=[redacted]");
}
