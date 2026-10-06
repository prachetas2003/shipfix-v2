import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverRepos,
  driveLiveRun,
  evaluateCorpus,
  evaluateEntry,
  findRegressions,
  loadCorpus,
  mergeCorpus,
  pruneNonApps,
  renderMarkdown,
  shapeSignature,
  summarize,
  summarizeLive,
  type RepoEvalResult,
} from "../src/index";

const FIXTURES = fileURLToPath(new URL("../../analyzer/test/fixtures", import.meta.url));
const CORPUS = fileURLToPath(new URL("../../../eval/corpus.json", import.meta.url));

function row(partial: Partial<RepoEvalResult> & { id: string }): RepoEvalResult {
  return {
    category: "test",
    status: "ok",
    planSource: "deterministic",
    classification: "deployable",
    issueCodes: [],
    blockerTitles: [],
    questionCount: 0,
    secretNames: [],
    expectationMet: null,
    timings: { cloneMs: 0, analyzeMs: 10, planMs: 0, validateMs: 0, totalMs: 10 },
    ...partial,
  };
}

describe("evaluateEntry on local fixtures", () => {
  it("runs the real pipeline and classifies the golden repo deployable", async () => {
    const r = await evaluateEntry({
      path: path.join(FIXTURES, "golden-fullstack"),
      category: "fixture",
      source: "curated",
      expect: "deployable",
    });
    expect(r.status).toBe("ok");
    expect(r.planSource).toBe("deterministic");
    expect(r.classification).toBe("deployable");
    expect(r.expectationMet).toBe(true);
    expect(r.shape?.services.map((s) => s.framework).sort()).toEqual(["express", "vite"]);
    expect(r.shape?.dataNeeds).toEqual(["postgres"]);
  });

  it("reports out-of-slice repos as unplanned offline instead of guessing", async () => {
    const r = await evaluateEntry({ path: path.join(FIXTURES, "docker-compose-only"), category: "fixture", source: "curated" });
    expect(r.status).toBe("ok");
    expect(r.planSource).toBe("none");
    expect(r.classification).toBeNull();
  });

  it("plans a FastAPI app on Render from its inferred start command", async () => {
    const r = await evaluateEntry({ path: path.join(FIXTURES, "fastapi-app"), category: "fixture", source: "curated" });
    expect(r.status).toBe("ok");
    expect(r.planSource).toBe("deterministic");
    expect(r.classification).toBe("deployable");
  });

  it("uses the LLM gateway when given one", async () => {
    const gateway = {
      id: "fake",
      complete: async () => {
        throw new Error("model unavailable");
      },
    };
    const r = await evaluateEntry(
      { path: path.join(FIXTURES, "docker-compose-only"), category: "fixture", source: "curated" },
      { gateway: gateway as never },
    );
    expect(["ok", "plan_failed"]).toContain(r.status);
    if (r.status === "ok") expect(r.planSource).toBe("llm_fallback");
  });

  it("turns clone failures into result rows", async () => {
    const r = await evaluateEntry(
      { repo: "acme/missing", category: "oss", source: "curated" },
      {
        clone: async () => {
          throw new Error("git clone failed: not found");
        },
      },
    );
    expect(r.status).toBe("clone_failed");
    expect(r.error).toContain("not found");
  });

  it("evaluates the checked-in fixture slice of the corpus as expected", async () => {
    const corpus = await loadCorpus(CORPUS);
    const fixtures = corpus.entries.filter((e) => e.category === "fixture");
    const results = await evaluateCorpus(fixtures, { concurrency: 4 });
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results.filter((r) => r.expectationMet === false)).toEqual([]);
    expect(results.filter((r) => r.expectationMet === true).length).toBeGreaterThanOrEqual(3);
  });
});

describe("corpus", () => {
  it("rejects entries with both repo and path, and dedupes case-insensitively", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "eval-corpus-"));
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ version: 1, entries: [{ repo: "a/b", path: "x" }] }));
    await expect(loadCorpus(bad)).rejects.toThrow();

    const good = path.join(dir, "good.json");
    await writeFile(good, JSON.stringify({ version: 1, entries: [{ repo: "A/B" }, { repo: "a/b" }, { path: "fx" }] }));
    const corpus = await loadCorpus(good);
    expect(corpus.entries).toHaveLength(2);
    expect(corpus.entries[1].path).toBe(path.join(dir, "fx"));
  });

  it("merges discovered repos without duplicates", () => {
    const { corpus, added } = mergeCorpus(
      { version: 1, entries: [{ repo: "a/b", category: "x", source: "curated" }], excluded: ["e/f"] },
      [
        { repo: "A/b", category: "y", source: "d" },
        { repo: "c/d", category: "y", source: "d" },
        { repo: "E/F", category: "y", source: "d" },
      ],
    );
    expect(added).toBe(1);
    expect(corpus.entries.map((e) => e.repo)).toEqual(["a/b", "c/d"]);
  });

  it("prunes discovered non-apps but never curated entries", () => {
    const shape = (n: number) => ({ services: new Array(n).fill({}) });
    const { corpus, removed } = pruneNonApps(
      {
        version: 1,
        entries: [
          { repo: "u/list", category: "vibe", source: "discover:q" },
          { repo: "u/app", category: "vibe", source: "discover:q" },
          { repo: "octocat/Hello-World", category: "negative", source: "curated" },
          { repo: "u/flaky", category: "vibe", source: "discover:q" },
        ],
        excluded: [],
      },
      [
        { id: "u/list", status: "ok", shape: shape(0) },
        { id: "u/app", status: "ok", shape: shape(1) },
        { id: "octocat/Hello-World", status: "ok", shape: shape(0) },
        { id: "u/flaky", status: "clone_failed" },
      ],
    );
    expect(removed).toEqual(["u/list"]);
    expect(corpus.entries.map((e) => e.repo)).toEqual(["u/app", "octocat/Hello-World", "u/flaky"]);
    expect(corpus.excluded).toEqual(["u/list"]);
  });
});

describe("summaries and regressions", () => {
  const results = [
    row({ id: "a" }),
    row({
      id: "b",
      classification: "needs_setup",
      issueCodes: ["user_secret_required"],
      secretNames: ["STRIPE_SECRET_KEY", "VITE_SUPABASE_URL"],
    }),
    row({
      id: "c",
      planSource: "none",
      classification: null,
      shape: {
        services: [{ rootDir: "", language: "python", framework: "fastapi", role: "backend" }],
        dataNeeds: ["postgres"],
        monorepoTool: "none",
        envRefCount: 0,
        hardcodedUrlCount: 0,
        fileCount: 3,
      },
    }),
    row({ id: "d", status: "clone_failed", classification: null, planSource: "none" }),
  ];

  it("computes rates over analyzed repos only", () => {
    const s = summarize(results);
    expect(s.total).toBe(4);
    expect(s.analyzed).toBe(3);
    expect(s.deployableRate).toBeCloseTo(0.333, 3);
    expect(s.actionableRate).toBeCloseTo(0.667, 3);
    expect(s.unplannedRate).toBeCloseTo(0.333, 3);
    expect(s.topUncoveredShapes).toEqual([{ key: "fastapi(backend) [postgres]", count: 1 }]);
    expect(s.topIssueCodes[0]).toEqual({ key: "user_secret_required", count: 1 });
    expect(s.topSecretNames.map((c) => c.key)).toEqual(["STRIPE_SECRET_KEY", "VITE_SUPABASE_URL"]);
    expect(s.medianSecretsPerSetupPlan).toBe(2);
  });

  it("flags classification downgrades but ignores clone flakes", () => {
    const current = [
      row({ id: "a", classification: "diagnose_only" }),
      row({ id: "b", status: "clone_failed", classification: null }),
    ];
    expect(findRegressions(results, current)).toEqual([{ id: "a", before: "deployable", after: "diagnose_only" }]);
  });

  it("renders a markdown report", () => {
    const md = renderMarkdown(
      { generatedAt: "now", mode: "offline", summary: summarize(results), results },
      [{ id: "a", before: "deployable", after: "needs_setup" }],
    );
    expect(md).toContain("Deployable first try | 33.3%");
    expect(md).toContain("Regressions vs baseline");
    expect(md).toContain("fastapi(backend) [postgres]");
    expect(md).toContain("`d` clone_failed");
  });

  it("builds stable shape signatures", () => {
    expect(
      shapeSignature({
        services: [
          { rootDir: "b", language: "node", framework: "vite", role: "frontend" },
          { rootDir: "a", language: "node", framework: "express", role: "backend" },
        ],
        dataNeeds: ["redis", "postgres"],
        monorepoTool: "none",
        envRefCount: 0,
        hardcodedUrlCount: 0,
        fileCount: 0,
      }),
    ).toBe("express(backend)+vite(frontend) [postgres,redis]");
  });
});

describe("discovery", () => {
  it("pages GitHub search, skips forks, and dedupes across queries", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const items = [
        { full_name: "u/app", default_branch: "main", fork: false, archived: false },
        { full_name: "u/fork", default_branch: "main", fork: true, archived: false },
      ];
      return new Response(JSON.stringify({ total_count: 2, items }), { status: 200 });
    }) as typeof fetch;
    const found = await discoverRepos({ fetchImpl, perQuery: 5, pageDelayMs: 0 });
    expect(found).toEqual([expect.objectContaining({ repo: "u/app", category: "lovable" })]);
    expect(calls.every((u) => u.includes("fork%3Afalse"))).toBe(true);
  });

  it("surfaces search errors", async () => {
    const fetchImpl = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    await expect(discoverRepos({ fetchImpl, pageDelayMs: 0 })).rejects.toThrow(/403/);
  });
});

describe("live mode", () => {
  it("starts a deploy run and polls to a terminal status", async () => {
    const statuses = ["deploying", "succeeded"];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
      if (url.endsWith("/runs/deploy")) return new Response(JSON.stringify({ runId: "r1" }), { status: 202 });
      return new Response(JSON.stringify({ run: { status: statuses.shift() } }), { status: 200 });
    }) as typeof fetch;
    const r = await driveLiveRun("u/app", { apiUrl: "http://api/", token: "t", pollMs: 1, fetchImpl });
    expect(r).toMatchObject({ runId: "r1", outcome: "succeeded" });
  });

  it("summarizes first-try live rate", () => {
    const s = summarizeLive([
      { id: "a", runId: "1", outcome: "succeeded", durationMs: 100 },
      { id: "b", runId: "2", outcome: "diagnosed", durationMs: 50 },
    ]);
    expect(s.firstTryLiveRate).toBe(0.5);
    expect(s.timeToLiveP50Ms).toBe(100);
  });
});
