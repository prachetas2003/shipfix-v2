import { describe, expect, it } from "vitest";
import { NEON_SNAPSHOT_PREFIX, snapshotNeonDatabase } from "../src/index";

function fakeNeon(existing: Array<{ id: string; name: string; created_at: string; default?: boolean }>, createStatus = 201) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://neon.test", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}${init?.body ? ` ${init.body}` : ""}`);
    if (method === "GET") return new Response(JSON.stringify({ branches: existing }), { status: 200 });
    if (method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(createStatus < 300 ? { branch: { id: "br-new" } } : { message: "branches limit exceeded" }), {
      status: createStatus,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const at = (iso: string) => () => new Date(iso);

describe("snapshotNeonDatabase", () => {
  it("creates a named branch from the default branch", async () => {
    const neon = fakeNeon([{ id: "br-main", name: "main", created_at: "2026-01-01", default: true }]);
    const res = await snapshotNeonDatabase("k", "proj-1", { fetchImpl: neon.fetchImpl, apiBase: "https://neon.test", now: at("2026-10-06T12:34:56.789Z") });
    expect(res).toEqual({ ok: true, branchName: `${NEON_SNAPSHOT_PREFIX}20261006t123456z`, branchId: "br-new", pruned: 0 });
    expect(neon.calls.at(-1)).toBe(`POST /projects/proj-1/branches {"branch":{"name":"${NEON_SNAPSHOT_PREFIX}20261006t123456z"}}`);
  });

  it("prunes the oldest ShipFix snapshots and never touches other branches", async () => {
    const neon = fakeNeon([
      { id: "br-main", name: "main", created_at: "2026-01-01", default: true },
      { id: "br-dev", name: "dev", created_at: "2026-01-02" },
      { id: "s1", name: `${NEON_SNAPSHOT_PREFIX}a`, created_at: "2026-02-01" },
      { id: "s2", name: `${NEON_SNAPSHOT_PREFIX}b`, created_at: "2026-03-01" },
      { id: "s3", name: `${NEON_SNAPSHOT_PREFIX}c`, created_at: "2026-04-01" },
    ]);
    const res = await snapshotNeonDatabase("k", "proj-1", { fetchImpl: neon.fetchImpl, apiBase: "https://neon.test", keep: 3 });
    expect(res).toMatchObject({ ok: true, pruned: 1 });
    expect(neon.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /projects/proj-1/branches/s1"]);
  });

  it("reports a failed snapshot without throwing", async () => {
    const neon = fakeNeon([], 422);
    const res = await snapshotNeonDatabase("k", "proj-1", { fetchImpl: neon.fetchImpl, apiBase: "https://neon.test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("branches limit exceeded");
  });
});

describe("restoreNeonBranch", () => {
  it("refuses a branch ShipFix did not create and does not call Neon", async () => {
    const neon = fakeNeon([]);
    const { restoreNeonBranch } = await import("../src/index");
    const res = await restoreNeonBranch("k", "proj-1", "main", { fetchImpl: neon.fetchImpl, apiBase: "https://neon.test" });
    expect(res.ok).toBe(false);
    expect(neon.calls).toEqual([]);
  });

  it("restores the default branch from a backup and keeps the current data", async () => {
    const { restoreNeonBranch, NEON_BACKUP_PREFIX } = await import("../src/index");
    const neon = fakeNeon([
      { id: "br-main", name: "main", created_at: "2026-01-01", default: true },
      { id: "br-bak", name: `${NEON_BACKUP_PREFIX}20261018t000000z`, created_at: "2026-10-18" },
    ]);
    const res = await restoreNeonBranch("k", "proj-1", `${NEON_BACKUP_PREFIX}20261018t000000z`, {
      fetchImpl: neon.fetchImpl,
      apiBase: "https://neon.test",
      now: at("2026-10-18T01:02:03.000Z"),
    });
    expect(res).toMatchObject({ ok: true, branchName: "shipfix-before-restore-20261018t010203z", branchId: "br-main" });
    expect(neon.calls.at(-1)).toContain("POST /projects/proj-1/branches/br-main/restore");
    expect(neon.calls.at(-1)).toContain("\"source_branch_id\":\"br-bak\"");
    expect(neon.calls.at(-1)).toContain("shipfix-before-restore-20261018t010203z");
  });
});
