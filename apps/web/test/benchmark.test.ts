import { describe, expect, it } from "vitest";
import { benchmarkByCategory, benchmarkPercent, benchmarkRepos, countBenchmark } from "../app/lib/benchmark";

describe("benchmark snapshot", () => {
  it("matches the 18 Oct 2026 public corpus slice", () => {
    const totals = countBenchmark(benchmarkRepos);
    expect(totals).toEqual({ repos: 323, firstTry: 57, afterSetup: 141, unplanned: 125 });
    expect(benchmarkPercent(totals.firstTry, totals.repos)).toBe("17.6%");
    expect(benchmarkPercent(totals.firstTry + totals.afterSetup, totals.repos)).toBe("61.3%");
    expect(new Set(benchmarkRepos.map((repo) => repo.repo)).size).toBe(323);
    expect(benchmarkRepos.every((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo.repo))).toBe(true);
  });

  it("breaks the same repos down by source", () => {
    const rows = Object.fromEntries(benchmarkByCategory(benchmarkRepos).map((row) => [row.id, row.counts]));
    expect(rows.lovable).toEqual({ repos: 74, firstTry: 21, afterSetup: 43, unplanned: 10 });
    expect(rows.bolt).toEqual({ repos: 67, firstTry: 10, afterSetup: 25, unplanned: 32 });
    expect(rows.v0).toEqual({ repos: 88, firstTry: 13, afterSetup: 55, unplanned: 20 });
    expect(rows.vibe).toEqual({ repos: 69, firstTry: 9, afterSetup: 13, unplanned: 47 });
    expect(rows.replit).toEqual({ repos: 25, firstTry: 4, afterSetup: 5, unplanned: 16 });
  });
});
