/**
 * Helpers for running Prisma migrations inside the sandbox after Neon provision.
 * Connection strings are passed only via exec env — never logged.
 */

import { migrateConnectionUrl, type NeonConnectionUrls } from "@shipfix/provisioner";
import type { Sandbox } from "@shipfix/sandbox";
import { installForMigration, migrationInstallDir } from "./migrationInstall";

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
  const cwd = migrationInstallDir(files, input.schemaPath);
  const awake = await wakeDatabase({
    sandbox: input.sandbox,
    cwd,
    env: { DATABASE_URL: direct, DIRECT_URL: direct, CI: "1" },
  });
  if (!awake.ok) return { ok: false, skipped: false, detail: awake.detail };
  // Run inside the package that owns the schema. From the repo root, npx does
  // not see that package's Prisma and downloads whatever is current instead.
  const schemaFromPackage = schemaPathForCwd(input.schemaPath, cwd);
  const command = hasMigrations
    ? prismaMigrateCommand(schemaFromPackage, input.packageManager)
    : prismaPushCommand(schemaFromPackage, input.packageManager);
  const verb = hasMigrations ? "prisma migrate deploy" : "prisma db push";
  const execOptions = {
    timeoutMs: input.timeoutMs ?? 300_000,
    cwd: cwd || undefined,
    env: {
      // Migrate must use the direct (non-pooler) URL.
      DATABASE_URL: direct,
      DIRECT_URL: direct,
      CI: "1",
    },
  };
  // A prisma.config.ts that selects the JavaScript schema engine ignores the
  // schema URL and reports a failed migration as "External error id#0".
  // The schema already has the URL, so set that config aside for this command.
  const configFile = findPrismaConfigFile(files, cwd);
  const parked = configFile ? `${configFile}.shipfix-bak` : null;
  if (configFile && parked) {
    const moved = await input.sandbox.exec(`mv ${configFile} ${parked}`, { cwd: cwd || undefined, timeoutMs: 30_000 });
    if (moved.exitCode !== 0) {
      const detail = `${moved.stdout}\n${moved.stderr}`.trim();
      return { ok: false, skipped: false, exitCode: moved.exitCode, detail: `Could not set aside ${configFile} before migrating. ${detail}` };
    }
  }
  let result;
  try {
    result = await input.sandbox.exec(command, execOptions);
    if (connectionRefused(result) && !result.timedOut) {
      const again = await wakeDatabase({ sandbox: input.sandbox, cwd, env: execOptions.env });
      if (again.ok) result = await input.sandbox.exec(command, execOptions);
    }
  } finally {
    if (configFile && parked) {
      await input.sandbox.exec(`mv ${parked} ${configFile}`, { cwd: cwd || undefined, timeoutMs: 30_000 });
    }
  }

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const detail = redactConnectionStrings(combined).slice(0, 2000);

  if (result.exitCode === 0 && !result.timedOut) {
    return { ok: true, skipped: false, exitCode: 0, detail: detail || `${verb} succeeded.` };
  }

  if (hasMigrations) {
    const applied = await applyCommittedSql({
      sandbox: input.sandbox,
      cwd,
      migrationsDir: migrationsDirForSchema(schemaFromPackage),
      env: execOptions.env,
    });
    if (applied.ok) {
      return {
        ok: true,
        skipped: false,
        exitCode: 0,
        detail: `Prisma migrate did not apply the SQL (${detail || verb}). ShipFix applied the committed migration files directly. ${applied.detail}`,
      };
    }
    return {
      ok: false,
      skipped: false,
      exitCode: result.exitCode,
      detail: `${detail || `${verb} exited ${result.exitCode}`}\n${applied.detail}`.slice(0, 2000),
    };
  }

  if (result.timedOut) {
    return { ok: false, skipped: false, exitCode: result.exitCode, detail: `${verb} timed out. ${detail}` };
  }
  return {
    ok: false,
    skipped: false,
    exitCode: result.exitCode,
    detail: detail || `${verb} exited ${result.exitCode}`,
  };
}

const APPLY_SQL_SCRIPT = `
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}
const migrationsDir = process.argv[2];
if (!migrationsDir) {
  console.error("migrations directory is missing");
  process.exit(1);
}

function statements(sql) {
  const out = [];
  let current = "";
  let quote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== "\\\\") quote = !quote;
    if (!quote && ch === ";") {
      const stmt = current.trim();
      if (stmt) out.push(stmt);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

let client = null;
let lastError = "database did not accept a connection";
for (let attempt = 1; attempt <= 12; attempt++) {
  const next = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  let failed = false;
  const fail = (error) => {
    failed = true;
    lastError = error instanceof Error ? error.message : String(error);
  };
  next.on("error", fail);
  try {
    await next.connect();
    if (!failed) await next.query("select 1");
  } catch (error) {
    fail(error);
  }
  if (!failed) {
    client = next;
    break;
  }
  await next.end().catch(() => undefined);
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (!client) {
  console.error(lastError);
  process.exit(1);
}
try {
  await client.query(\`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )\`);
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const sql = await readFile(migrationsDir + "/" + name + "/migration.sql", "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      'SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1',
      [name],
    );
    if (existing.rowCount) continue;
    await client.query("BEGIN");
    try {
      for (const stmt of statements(sql)) {
        await client.query("SAVEPOINT stmt");
        try {
          await client.query(stmt);
          await client.query("RELEASE SAVEPOINT stmt");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT stmt");
          if (!(error && error.code === "42P07")) throw error;
        }
      }
      await client.query(
        'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), 1)',
        [randomUUID(), checksum, name],
      );
      await client.query("COMMIT");
      console.log("applied " + name);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
} finally {
  await client.end();
}
`;

const WAKE_DB_SCRIPT = `
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

let lastError = "database did not accept a connection";
for (let attempt = 1; attempt <= 12; attempt++) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  let failed = false;
  const fail = (error) => {
    failed = true;
    lastError = error instanceof Error ? error.message : String(error);
  };
  client.on("error", fail);
  try {
    await client.connect();
    if (!failed) await client.query("select 1");
  } catch (error) {
    fail(error);
  }
  await client.end().catch(() => undefined);
  if (!failed) {
    console.log("database accepted a connection");
    process.exit(0);
  }
  console.error("attempt " + attempt + " failed: " + lastError);
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5000));
}
process.exit(1);
`;

function connectionRefused(result: { stdout: string; stderr: string }): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return /P1001|Can't reach database server|Connection terminated unexpectedly|ECONNREFUSED|timeout expired/i.test(text);
}

/** Free Neon databases sleep. The first connection is often dropped while the server wakes. */
async function wakeDatabase(input: {
  sandbox: Sandbox;
  cwd: string;
  env: Record<string, string>;
}): Promise<{ ok: boolean; detail: string }> {
  const scriptName = ".shipfix-wake-db.mjs";
  const scriptPath = input.cwd ? `${input.cwd}/${scriptName}` : scriptName;
  await input.sandbox.writeFile(scriptPath, WAKE_DB_SCRIPT);
  try {
    const result = await input.sandbox.exec(`node ${scriptName}`, {
      cwd: input.cwd || undefined,
      timeoutMs: 180_000,
      env: input.env,
    });
    const detail = redactConnectionStrings(`${result.stdout}\n${result.stderr}`.trim()).slice(0, 1500);
    if (result.timedOut) return { ok: false, detail: `The database did not wake up in time. ${detail}` };
    if (result.exitCode !== 0) {
      return { ok: false, detail: detail || "The database did not accept a connection." };
    }
    return { ok: true, detail };
  } finally {
    await input.sandbox.exec(`rm -f ${scriptName}`, { cwd: input.cwd || undefined, timeoutMs: 30_000 }).catch(() => undefined);
  }
}

async function applyCommittedSql(input: {
  sandbox: Sandbox;
  cwd: string;
  migrationsDir: string;
  env: Record<string, string>;
}): Promise<{ ok: boolean; detail: string }> {
  const scriptName = ".shipfix-apply-sql.mjs";
  const scriptPath = input.cwd ? `${input.cwd}/${scriptName}` : scriptName;
  await input.sandbox.writeFile(scriptPath, APPLY_SQL_SCRIPT);
  try {
    const result = await input.sandbox.exec(`node ${scriptName} ${input.migrationsDir}`, {
      cwd: input.cwd || undefined,
      timeoutMs: 120_000,
      env: input.env,
    });
    const detail = redactConnectionStrings(`${result.stdout}\n${result.stderr}`.trim()).slice(0, 1500);
    if (result.timedOut) return { ok: false, detail: `Applying the committed SQL timed out. ${detail}` };
    if (result.exitCode !== 0) return { ok: false, detail: detail || `Applying the committed SQL exited ${result.exitCode}` };
    return { ok: true, detail: detail || "Committed SQL applied." };
  } finally {
    await input.sandbox.exec(`rm -f ${scriptName}`, { cwd: input.cwd || undefined, timeoutMs: 30_000 }).catch(() => undefined);
  }
}

function migrationsDirForSchema(schemaFromPackage: string): string {
  const slash = schemaFromPackage.lastIndexOf("/");
  const dir = slash === -1 ? "" : schemaFromPackage.slice(0, slash);
  return dir ? `${dir}/migrations` : "migrations";
}

const PRISMA_CONFIG_FILES = [
  "prisma.config.ts",
  "prisma.config.js",
  "prisma.config.mjs",
  "prisma.config.cjs",
  "prisma.config.mts",
  "prisma.config.cts",
];

function findPrismaConfigFile(files: readonly string[], cwd: string): string | null {
  for (const name of PRISMA_CONFIG_FILES) {
    const full = cwd ? `${cwd}/${name}` : name;
    if (files.includes(full)) return name;
  }
  return null;
}

function schemaPathForCwd(schemaPath: string, cwd: string): string {
  if (!cwd) return schemaPath;
  const prefix = `${cwd}/`;
  return schemaPath.startsWith(prefix) ? schemaPath.slice(prefix.length) : schemaPath;
}

function redactConnectionStrings(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, "postgres://[redacted]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[redacted]")
    .replace(/DIRECT_URL=[^\s]+/gi, "DIRECT_URL=[redacted]");
}
