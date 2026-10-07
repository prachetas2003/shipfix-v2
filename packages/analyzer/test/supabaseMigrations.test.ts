import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { analyzeRepo } from "../src/index";

function repo(files: Record<string, string | object>) {
  const text = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  return {
    listFiles: async () => Object.keys(text),
    readFile: async (p: string) => text[p] ?? null,
  };
}

const lovableApp = (migrations: Record<string, string>) => ({
  "package.json": { name: "app", scripts: { build: "vite build" }, dependencies: { react: "18", "react-dom": "18", "@supabase/supabase-js": "2" }, devDependencies: { vite: "5" } },
  "package-lock.json": "{}",
  "supabase/config.toml": 'project_id = "abcdefghijklmnopqrst"\n',
  "src/integrations/supabase/client.ts": "createClient('https://abcdefghijklmnopqrst.supabase.co', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);",
  ...Object.fromEntries(Object.entries(migrations).map(([k, v]) => [`supabase/migrations/${k}`, v])),
});

describe("Supabase migrations and RLS", () => {
  it("lists migrations in order and finds tables left without RLS", async () => {
    const ctx = await analyzeRepo(
      repo(
        lovableApp({
          "20240201000000_b.sql": [
            "alter table public.notes enable row level security;",
            "create table if not exists \"public\".\"tasks\" (id uuid primary key);",
            "create table public.old (id int);",
            "drop table if exists public.old;",
            "create table storage_meta.files (id int);",
            "-- create table public.commented (id int);",
            "create function public.touch() returns trigger as $$ begin create table public.inside(id int); return new; end; $$ language plpgsql;",
          ].join("\n"),
          "20240101000000_a.sql": "create table public.profiles (id uuid primary key);\nalter table public.profiles enable row level security;\ncreate table notes (id int);",
        }),
      ),
      { repoFullName: "t/t", commitSha: "0".repeat(40) },
    );
    expect(ctx.supabase?.migrations?.map((m) => m.version)).toEqual(["20240101000000", "20240201000000"]);
    expect(ctx.supabase?.tablesWithoutRls).toEqual(["tasks"]);

    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.integrations?.[0]?.migrations?.map((m) => m.file)).toEqual([
      "supabase/migrations/20240101000000_a.sql",
      "supabase/migrations/20240201000000_b.sql",
    ]);
    const titles = plan.blockers.map((b) => b.title);
    expect(titles).toContain("Applies your pending Supabase migrations");
    expect(titles).toContain("Database tables without row-level security");
    expect(plan.blockers.every((b) => b.severity === "warning")).toBe(true);
  });

  it("does not warn when every table has RLS", async () => {
    const ctx = await analyzeRepo(
      repo(lovableApp({ "20240101_a.sql": "create table public.t (id int);\nALTER TABLE ONLY public.t ENABLE ROW LEVEL SECURITY;" })),
      { repoFullName: "t/t", commitSha: "0".repeat(40) },
    );
    expect(ctx.supabase?.tablesWithoutRls).toEqual([]);
    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.blockers.map((b) => b.title)).not.toContain("Database tables without row-level security");
  });
});
