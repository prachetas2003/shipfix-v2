/**
 * Apply a repo's `supabase/migrations` to the user's existing Supabase project
 * through the Management API, the way `supabase db push` does: run each
 * pending file and record its version in supabase_migrations.schema_migrations.
 * Every decision that could touch existing data is made conservatively here.
 */
import { supabaseRequest, type SupabaseApiOptions } from "./supabase";

export interface RepoMigration {
  version: string;
  name: string;
  file: string;
}

export type MigrationDecision =
  | { kind: "up_to_date" }
  | { kind: "apply"; pending: RepoMigration[] }
  | { kind: "unsafe"; reason: string };

/** Versions are timestamps of varying precision ("20240101" vs "20240101120000"). */
function versionKey(v: string): string {
  return v.padEnd(14, "0");
}

/**
 * Which repo migrations to run. Only a clean tail is applied: every pending
 * migration must be newer than the newest one the project already ran. An
 * empty history is only trusted when the public schema has no tables yet.
 */
export function decideSupabaseMigrations(
  repo: readonly RepoMigration[],
  applied: readonly string[],
  publicTableCount: number | null,
): MigrationDecision {
  const done = new Set(applied);
  const pending = repo.filter((m) => !done.has(m.version));
  if (pending.length === 0) return { kind: "up_to_date" };
  if (applied.length === 0) {
    if (publicTableCount === 0) return { kind: "apply", pending };
    return {
      kind: "unsafe",
      reason: `Your Supabase project already has tables but no migration history, so ShipFix can't tell which of the repo's ${repo.length} migrations already ran.`,
    };
  }
  const newest = applied.reduce((a, b) => (versionKey(b) > versionKey(a) ? b : a));
  const older = pending.find((m) => versionKey(m.version) <= versionKey(newest));
  if (older) {
    return {
      kind: "unsafe",
      reason: `Migration ${older.version} is not in your project's history but is older than the newest migration it already ran (${newest}). It may have been applied another way, so ShipFix won't run it automatically.`,
    };
  }
  return { kind: "apply", pending };
}

/** Function bodies and comments are not executed at migration time. */
function executableSql(sql: string): string {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Statements that can't run inside the single transaction ShipFix wraps each migration in. */
export function migrationSqlProblem(sql: string): string | null {
  const code = executableSql(sql);
  if (/(^|;)\s*(begin|start\s+transaction|commit|rollback|end)\s*(;|$)/im.test(code)) {
    return "it manages its own transactions";
  }
  if (/\bconcurrently\b/i.test(code)) return "it builds indexes concurrently";
  if (/\bvacuum\b/i.test(code)) return "it runs VACUUM";
  return null;
}

/**
 * Statements that remove or rewrite stored data. Dropping policies, triggers,
 * functions, indexes or views loses no rows and is routine in migrations.
 */
export function isDestructiveSql(sql: string): boolean {
  const code = executableSql(sql);
  return (
    /\bdrop\s+(table|column|schema|type)\b/i.test(code) ||
    /\b(truncate|delete\s+from)\b/i.test(code) ||
    /\balter\s+table\b[^;]*\b(drop|rename|alter\s+column\b[^;]*\btype)\b/i.test(code) ||
    /\bupdate\s+[\w."]+\s+set\b/i.test(code)
  );
}

/**
 * One query string = one implicit transaction in Postgres's simple query
 * protocol, so the migration and its history row commit together or not at all.
 */
export function migrationQuery(m: RepoMigration, sql: string): string {
  const version = m.version.replace(/\D/g, "");
  const name = m.name.replace(/[^\w-]/g, "");
  return [
    sql,
    ";",
    "create schema if not exists supabase_migrations;",
    "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);",
    `insert into supabase_migrations.schema_migrations (version, name, statements) values ('${version}', '${name}', '{}');`,
  ].join("\n");
}

type ApiResult<T> = { ok: true; value: T } | { ok: false; message: string };

function apiMessage(action: string, status: number, body: unknown): string {
  const detail =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? `: ${(body as { message: string }).message.slice(0, 300)}`
      : "";
  if (status === 401 || status === 403) return `Supabase rejected the access token while trying to ${action}.`;
  return `Supabase could not ${action} (HTTP ${status || "network"})${detail}`;
}

async function readQuery<T>(token: string, ref: string, query: string, opts: SupabaseApiOptions): Promise<ApiResult<T[]>> {
  const res = await supabaseRequest("POST", `/projects/${encodeURIComponent(ref)}/database/query`, token, opts, {
    query,
    read_only: true,
  });
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body)) {
    return { ok: false, message: apiMessage("read the database", res.status, res.body) };
  }
  return { ok: true, value: res.body as T[] };
}

export async function listAppliedSupabaseMigrations(
  token: string,
  ref: string,
  opts: SupabaseApiOptions = {},
): Promise<ApiResult<string[]>> {
  const res = await supabaseRequest("GET", `/projects/${encodeURIComponent(ref)}/database/migrations`, token, opts);
  if (res.status !== 200 || !Array.isArray(res.body)) {
    return { ok: false, message: apiMessage("list applied migrations", res.status, res.body) };
  }
  const versions = (res.body as Array<{ version?: unknown }>)
    .map((r) => (typeof r.version === "string" ? r.version : null))
    .filter((v): v is string => Boolean(v));
  return { ok: true, value: versions };
}

export async function countPublicTables(token: string, ref: string, opts: SupabaseApiOptions = {}): Promise<ApiResult<number>> {
  const res = await readQuery<{ n?: number }>(
    token,
    ref,
    "select count(*)::int as n from pg_catalog.pg_tables where schemaname = 'public';",
    opts,
  );
  return res.ok ? { ok: true, value: Number(res.value[0]?.n ?? 0) } : res;
}

/** Live check: public tables the anon key can reach with no row-level security. */
export async function publicTablesWithoutRls(
  token: string,
  ref: string,
  opts: SupabaseApiOptions = {},
): Promise<ApiResult<string[]>> {
  const res = await readQuery<{ name?: string }>(
    token,
    ref,
    "select c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1;",
    opts,
  );
  return res.ok ? { ok: true, value: res.value.map((r) => r.name).filter((n): n is string => Boolean(n)) } : res;
}

export async function applySupabaseMigration(
  token: string,
  ref: string,
  m: RepoMigration,
  sql: string,
  opts: SupabaseApiOptions = {},
): Promise<ApiResult<null>> {
  const res = await supabaseRequest("POST", `/projects/${encodeURIComponent(ref)}/database/query`, token, opts, {
    query: migrationQuery(m, sql),
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: apiMessage(`apply migration ${m.version}`, res.status, res.body) };
  }
  return { ok: true, value: null };
}

/**
 * Ask Supabase for a restore point and wait until it is usable. Not every
 * plan supports restore points; callers treat failure as "no snapshot".
 */
export async function createSupabaseRestorePoint(
  token: string,
  ref: string,
  name: string,
  opts: SupabaseApiOptions & { pollMs?: number; waitMs?: number } = {},
): Promise<ApiResult<string>> {
  const path = `/projects/${encodeURIComponent(ref)}/database/backups/restore-point`;
  const created = await supabaseRequest("POST", path, token, opts, { name: name.slice(0, 20) });
  if (created.status < 200 || created.status >= 300) {
    return { ok: false, message: apiMessage("create a restore point", created.status, created.body) };
  }
  const deadline = Date.now() + (opts.waitMs ?? 120_000);
  let status = (created.body as { status?: string } | null)?.status;
  while (status !== "AVAILABLE") {
    if (status === "FAILED" || status === "REMOVED") return { ok: false, message: `Supabase restore point ${status.toLowerCase()}.` };
    if (Date.now() > deadline) return { ok: false, message: "Supabase restore point was not ready in time." };
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3_000));
    const res = await supabaseRequest("GET", `${path}?name=${encodeURIComponent(name.slice(0, 20))}`, token, opts);
    status = (res.body as { status?: string } | null)?.status;
  }
  return { ok: true, value: name.slice(0, 20) };
}
