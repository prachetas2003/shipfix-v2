import {
  applySupabaseMigration,
  countPublicTables,
  createSupabaseRestorePoint,
  decideSupabaseMigrations,
  isDestructiveSql,
  listAppliedSupabaseMigrations,
  migrationSqlProblem,
  publicTablesWithoutRls,
  type RepoMigration,
  type SupabaseApiOptions,
} from "@shipfix/provisioner";

export interface SupabaseMigrationOutcome {
  applied: string[];
  /** Pending migrations ShipFix deliberately did not run, with a user-facing reason. */
  skipped?: { versions: string[]; reason: string };
  failed?: { version: string; message: string };
  restorePoint: string | null;
  /** Live check after migrating; null when the check itself failed. */
  tablesWithoutRls: string[] | null;
}

export interface SupabaseMigrationDeps {
  token: string;
  ref: string;
  /** Repo file contents at the run's commit. */
  readFile: (path: string) => Promise<string | null>;
  restorePointName: string;
  api?: SupabaseApiOptions & { pollMs?: number; waitMs?: number };
}

export async function migrateSupabaseProject(
  migrations: readonly RepoMigration[],
  deps: SupabaseMigrationDeps,
): Promise<SupabaseMigrationOutcome> {
  const outcome: SupabaseMigrationOutcome = { applied: [], restorePoint: null, tablesWithoutRls: null };
  const { token, ref, api } = deps;
  const finish = async (): Promise<SupabaseMigrationOutcome> => {
    const rls = await publicTablesWithoutRls(token, ref, api);
    outcome.tablesWithoutRls = rls.ok ? rls.value : null;
    return outcome;
  };
  if (migrations.length === 0) return finish();

  const applied = await listAppliedSupabaseMigrations(token, ref, api);
  if (!applied.ok) {
    outcome.skipped = { versions: [], reason: applied.message };
    return finish();
  }
  let tableCount: number | null = null;
  if (applied.value.length === 0) {
    const count = await countPublicTables(token, ref, api);
    tableCount = count.ok ? count.value : null;
  }
  const decision = decideSupabaseMigrations(migrations, applied.value, tableCount);
  if (decision.kind === "up_to_date") return finish();
  const versions = decision.kind === "apply" ? decision.pending.map((m) => m.version) : [];
  if (decision.kind === "unsafe") {
    outcome.skipped = { versions: migrations.filter((m) => !applied.value.includes(m.version)).map((m) => m.version), reason: decision.reason };
    return finish();
  }

  const files: Array<{ m: RepoMigration; sql: string }> = [];
  for (const m of decision.pending) {
    const sql = await deps.readFile(m.file);
    if (sql === null || !sql.trim()) {
      outcome.skipped = { versions, reason: `Migration file ${m.file} could not be read.` };
      return finish();
    }
    const problem = migrationSqlProblem(sql);
    if (problem) {
      outcome.skipped = {
        versions,
        reason: `Migration ${m.version} can't run in a single transaction because ${problem}. Apply it with the Supabase CLI ("supabase db push"), then rerun deploy.`,
      };
      return finish();
    }
    files.push({ m, sql });
  }

  const snapshot = await createSupabaseRestorePoint(token, ref, deps.restorePointName, api);
  if (snapshot.ok) {
    outcome.restorePoint = snapshot.value;
  } else {
    const destructive = files.find((f) => isDestructiveSql(f.sql));
    if (destructive) {
      outcome.skipped = {
        versions,
        reason: `Migration ${destructive.m.version} drops, deletes or rewrites existing data, and ShipFix could not create a restore point first (${snapshot.message}). Review and apply it with the Supabase CLI, then rerun deploy.`,
      };
      return finish();
    }
  }

  for (const { m, sql } of files) {
    const res = await applySupabaseMigration(token, ref, m, sql, api);
    if (!res.ok) {
      outcome.failed = { version: m.version, message: res.message };
      return finish();
    }
    outcome.applied.push(m.version);
  }
  return finish();
}
