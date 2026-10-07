import type { SupabaseMigration } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { MAX_SCAN_BYTES } from "./util";

const MIGRATION_RE = /^supabase\/migrations\/(\d{6,})_?([^/]*)\.sql$/;
const MAX_MIGRATIONS = 500;

export function listSupabaseMigrations(files: ReadonlySet<string>): SupabaseMigration[] {
  const out: SupabaseMigration[] = [];
  for (const file of files) {
    const m = MIGRATION_RE.exec(file);
    if (m) out.push({ version: m[1], name: m[2], file });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version)).slice(0, MAX_MIGRATIONS);
}

/** Comments and function bodies ($$ ... $$) can mention DDL that never runs at migration time. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

const IDENT = String.raw`(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?`;
const CREATE_RE = new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${IDENT}`, "gi");
const RLS_RE = new RegExp(
  String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}\s+(enable|disable)\s+row\s+level\s+security`,
  "gi",
);
const RENAME_RE = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}\s+rename\s+to\s+"?(\w+)"?`, "gi");
const DROP_RE = /\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]+)/gi;

interface Event {
  at: number;
  apply: (tables: Map<string, boolean>) => void;
}

/**
 * Replays the migrations in order and returns public tables that end up
 * without row-level security. With RLS off, anyone holding the app's public
 * anon key can read and write those tables through the Supabase API.
 */
export async function tablesWithoutRls(source: RepoSource, migrations: SupabaseMigration[]): Promise<string[]> {
  const tables = new Map<string, boolean>();
  const isPublic = (schema: string | undefined): boolean => !schema || schema.toLowerCase() === "public";
  for (const m of migrations) {
    const sql = stripSqlNoise(((await source.readFile(m.file)) ?? "").slice(0, MAX_SCAN_BYTES));
    const events: Event[] = [];
    for (const x of sql.matchAll(CREATE_RE)) {
      const [, schema, name] = x;
      if (isPublic(schema)) events.push({ at: x.index ?? 0, apply: (t) => { if (!t.has(name.toLowerCase())) t.set(name.toLowerCase(), false); } });
    }
    for (const x of sql.matchAll(RLS_RE)) {
      const [, schema, name, mode] = x;
      if (isPublic(schema)) events.push({ at: x.index ?? 0, apply: (t) => { t.set(name.toLowerCase(), mode.toLowerCase() === "enable"); } });
    }
    for (const x of sql.matchAll(RENAME_RE)) {
      const [, schema, from, to] = x;
      if (!isPublic(schema)) continue;
      events.push({
        at: x.index ?? 0,
        apply: (t) => {
          const state = t.get(from.toLowerCase());
          if (state === undefined) return;
          t.delete(from.toLowerCase());
          t.set(to.toLowerCase(), state);
        },
      });
    }
    for (const x of sql.matchAll(DROP_RE)) {
      const names = x[1].replace(/\b(cascade|restrict)\b/gi, "").split(",");
      events.push({
        at: x.index ?? 0,
        apply: (t) => {
          for (const raw of names) {
            const m2 = new RegExp(`^\\s*${IDENT}\\s*$`).exec(raw);
            if (m2 && isPublic(m2[1])) t.delete(m2[2].toLowerCase());
          }
        },
      });
    }
    for (const e of events.sort((a, b) => a.at - b.at)) e.apply(tables);
  }
  return [...tables].filter(([, rls]) => !rls).map(([name]) => name).sort();
}
