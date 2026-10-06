import { describe, expect, it } from "vitest";
import { fetchSupabaseProjectValues, pickSupabaseKeys } from "../src/supabase";

const TOKEN = "sbp_test_token_value";

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const hit = Object.entries(routes).find(([k]) => u.endsWith(k));
    const { status, body } = hit?.[1] ?? { status: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const KEYS = [
  { name: "anon", type: "legacy", api_key: "eyJ.anon" },
  { name: "service_role", type: "legacy", api_key: "eyJ.service" },
  { name: "default", type: "publishable", api_key: "sb_publishable_x" },
  { name: "default", type: "secret", api_key: "sb_secret_x" },
];

describe("Supabase project values", () => {
  it("prefers legacy JWT keys and falls back to the newer key types", () => {
    expect(pickSupabaseKeys(KEYS)).toEqual({ anonKey: "eyJ.anon", serviceRoleKey: "eyJ.service" });
    expect(pickSupabaseKeys(KEYS.slice(2))).toEqual({ anonKey: "sb_publishable_x", serviceRoleKey: "sb_secret_x" });
    expect(pickSupabaseKeys([{ name: "anon", api_key: null }])).toEqual({ anonKey: null, serviceRoleKey: null });
  });

  it("reads URL and keys for a known project ref", async () => {
    const { impl, calls } = fakeFetch({ "/projects/abcdefghijklmnopqrst/api-keys?reveal=true": { status: 200, body: KEYS } });
    const res = await fetchSupabaseProjectValues(TOKEN, "abcdefghijklmnopqrst", { fetchImpl: impl });
    expect(res).toEqual({
      ok: true,
      values: {
        projectRef: "abcdefghijklmnopqrst",
        url: "https://abcdefghijklmnopqrst.supabase.co",
        anonKey: "eyJ.anon",
        serviceRoleKey: "eyJ.service",
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("uses the account's only project when the repo doesn't name one, and refuses to guess among several", async () => {
    const one = fakeFetch({
      "/projects": { status: 200, body: [{ id: "onlyprojectrefxxxxxx", name: "app" }] },
      "/projects/onlyprojectrefxxxxxx/api-keys?reveal=true": { status: 200, body: KEYS },
    });
    const ok = await fetchSupabaseProjectValues(TOKEN, null, { fetchImpl: one.impl });
    expect(ok.ok && ok.values.projectRef).toBe("onlyprojectrefxxxxxx");

    const many = fakeFetch({ "/projects": { status: 200, body: [{ ref: "a".repeat(20) }, { ref: "b".repeat(20) }] } });
    const ambiguous = await fetchSupabaseProjectValues(TOKEN, null, { fetchImpl: many.impl });
    expect(ambiguous).toMatchObject({ ok: false, code: "project_ambiguous" });
  });

  it("reports rejected tokens and missing projects without echoing the token", async () => {
    const denied = fakeFetch({ "/api-keys?reveal=true": { status: 401, body: {} } });
    const r1 = await fetchSupabaseProjectValues(TOKEN, "x".repeat(20), { fetchImpl: denied.impl });
    expect(r1).toMatchObject({ ok: false, code: "unauthorized" });
    expect(JSON.stringify(r1)).not.toContain(TOKEN);

    const missing = fakeFetch({});
    const r2 = await fetchSupabaseProjectValues(TOKEN, "y".repeat(20), { fetchImpl: missing.impl });
    expect(r2).toMatchObject({ ok: false, code: "project_not_found" });
  });
});
