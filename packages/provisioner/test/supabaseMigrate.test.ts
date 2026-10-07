import { describe, expect, it } from "vitest";
import {
  decideSupabaseMigrations,
  isDestructiveSql,
  migrationQuery,
  migrationSqlProblem,
} from "../src/index";

const m = (version: string) => ({ version, name: `m${version}`, file: `supabase/migrations/${version}_m.sql` });

describe("decideSupabaseMigrations", () => {
  const repo = [m("20240101000000"), m("20240201000000"), m("20240301000000")];

  it("is up to date when every repo migration is in the history", () => {
    expect(decideSupabaseMigrations(repo, repo.map((x) => x.version), null)).toEqual({ kind: "up_to_date" });
  });

  it("applies only the newer tail", () => {
    const d = decideSupabaseMigrations(repo, ["20240101000000", "20240201000000"], null);
    expect(d).toEqual({ kind: "apply", pending: [repo[2]] });
  });

  it("refuses a pending migration older than the newest applied one", () => {
    const d = decideSupabaseMigrations(repo, ["20240101000000", "20240301000000"], null);
    expect(d.kind).toBe("unsafe");
  });

  it("trusts an empty history only when the public schema is empty", () => {
    expect(decideSupabaseMigrations(repo, [], 0)).toEqual({ kind: "apply", pending: repo });
    expect(decideSupabaseMigrations(repo, [], 4).kind).toBe("unsafe");
    expect(decideSupabaseMigrations(repo, [], null).kind).toBe("unsafe");
  });

  it("compares versions of different precision", () => {
    const d = decideSupabaseMigrations([m("20240101"), m("20240102120000")], ["20240101"], null);
    expect(d).toEqual({ kind: "apply", pending: [m("20240102120000")] });
  });
});

describe("migration SQL checks", () => {
  it("ignores BEGIN inside function bodies but rejects real transaction control", () => {
    const fn = "create function f() returns trigger as $$ begin return new; end; $$ language plpgsql;";
    expect(migrationSqlProblem(fn)).toBeNull();
    expect(migrationSqlProblem("begin;\ncreate table t(id int);\ncommit;")).toMatch(/transactions/);
    expect(migrationSqlProblem("create index concurrently i on t(id);")).toMatch(/concurrently/);
  });

  it("treats policy churn as safe and data loss as destructive", () => {
    expect(isDestructiveSql('drop policy if exists "read" on public.posts;\ncreate policy "read" on public.posts for select using (true);')).toBe(false);
    expect(isDestructiveSql("drop table public.posts;")).toBe(true);
    expect(isDestructiveSql("alter table public.posts drop column body;")).toBe(true);
    expect(isDestructiveSql("delete from public.posts where id = 1;")).toBe(true);
    expect(isDestructiveSql("-- drop table public.posts\ncreate table public.x(id int);")).toBe(false);
  });

  it("records the repo's version in the same query as the migration", () => {
    const q = migrationQuery({ version: "20240101000000", name: "add'posts", file: "f" }, "create table t(id int) -- trailing comment");
    expect(q.startsWith("create table t(id int) -- trailing comment\n;")).toBe(true);
    expect(q).toContain("values ('20240101000000', 'addposts', '{}')");
  });
});
