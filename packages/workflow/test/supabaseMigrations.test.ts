import { describe, expect, it } from "vitest";
import { migrateSupabaseProject } from "../src/supabaseMigrations";

const REF = "abcdefghijklmnopqrst";
const m = (version: string) => ({ version, name: "m", file: `supabase/migrations/${version}_m.sql` });

function fakeSupabase(opts: { applied: string[]; restorePoint: boolean; failVersion?: string; openTables?: string[] }) {
  const queries: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.endsWith(`/projects/${REF}/database/migrations`)) return json(opts.applied.map((version) => ({ version })));
    if (u.includes("/backups/restore-point")) {
      return opts.restorePoint ? json({ name: body?.name, status: "AVAILABLE", completed_on: null }, 201) : json({ message: "not available on free plan" }, 400);
    }
    if (u.endsWith("/database/query") && method === "POST") {
      if (body.read_only) {
        if (String(body.query).includes("relrowsecurity")) return json((opts.openTables ?? []).map((name) => ({ name })), 201);
        return json([{ n: 0 }], 201);
      }
      queries.push(body.query);
      if (opts.failVersion && String(body.query).includes(`'${opts.failVersion}'`)) return json({ message: "relation exists" }, 400);
      return json([], 201);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, queries };
}

const files: Record<string, string> = {
  "supabase/migrations/1_m.sql": "create table public.a(id int);",
  "supabase/migrations/2_m.sql": "create table public.b(id int);",
  "supabase/migrations/3_m.sql": "alter table public.a drop column id;",
};

describe("migrateSupabaseProject", () => {
  it("applies the pending tail after a restore point and reports open tables", async () => {
    const api = fakeSupabase({ applied: ["1"], restorePoint: true, openTables: ["b"] });
    const out = await migrateSupabaseProject([m("1"), m("2"), m("3")], {
      token: "t",
      ref: REF,
      readFile: async (p) => files[p] ?? null,
      restorePointName: "shipfix-x",
      api: { fetchImpl: api.fetchImpl, pollMs: 1 },
    });
    expect(out).toMatchObject({ applied: ["2", "3"], restorePoint: "shipfix-x", tablesWithoutRls: ["b"] });
    expect(api.queries).toHaveLength(2);
    expect(api.queries[0]).toContain("create table public.b");
  });

  it("skips destructive migrations when no restore point can be made", async () => {
    const api = fakeSupabase({ applied: ["1"], restorePoint: false });
    const out = await migrateSupabaseProject([m("1"), m("2"), m("3")], {
      token: "t",
      ref: REF,
      readFile: async (p) => files[p] ?? null,
      restorePointName: "shipfix-x",
      api: { fetchImpl: api.fetchImpl },
    });
    expect(out.applied).toEqual([]);
    expect(out.skipped?.versions).toEqual(["2", "3"]);
    expect(out.skipped?.reason).toMatch(/restore point/);
    expect(api.queries).toEqual([]);
  });

  it("applies additive migrations without a restore point and stops at the first failure", async () => {
    const api = fakeSupabase({ applied: ["1"], restorePoint: false, failVersion: "2" });
    const out = await migrateSupabaseProject([m("1"), m("2")], {
      token: "t",
      ref: REF,
      readFile: async (p) => files[p] ?? null,
      restorePointName: "shipfix-x",
      api: { fetchImpl: api.fetchImpl },
    });
    expect(out.applied).toEqual([]);
    expect(out.failed).toMatchObject({ version: "2" });
    expect(out.failed?.message).toContain("relation exists");
  });

  it("does nothing to a project whose history already covers the repo", async () => {
    const api = fakeSupabase({ applied: ["1", "2"], restorePoint: true });
    const out = await migrateSupabaseProject([m("1"), m("2")], {
      token: "t",
      ref: REF,
      readFile: async () => {
        throw new Error("should not read files");
      },
      restorePointName: "shipfix-x",
      api: { fetchImpl: api.fetchImpl },
    });
    expect(out).toMatchObject({ applied: [], restorePoint: null, tablesWithoutRls: [] });
    expect(out.skipped).toBeUndefined();
  });
});
