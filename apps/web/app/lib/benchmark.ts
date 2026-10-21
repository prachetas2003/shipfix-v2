import { benchmarkGeneratedAt, benchmarkRepos } from "./benchmarkData";

export { benchmarkGeneratedAt, benchmarkRepos };

/** AI-builder repos in that run that failed to clone and are left out of the rates. */
export const benchmarkUncloned = 18;

export const benchmarkCategories = [
  { id: "lovable", label: "Lovable" },
  { id: "bolt", label: "Bolt" },
  { id: "v0", label: "v0" },
  { id: "vibe", label: "Cursor and vibe-coding" },
  { id: "replit", label: "Replit" },
] as const;

export type BenchmarkCategory = (typeof benchmarkCategories)[number]["id"];
export type BenchmarkOutcome = (typeof benchmarkRepos)[number]["outcome"];

export interface BenchmarkCounts {
  repos: number;
  firstTry: number;
  afterSetup: number;
  unplanned: number;
}

export function countBenchmark(
  repos: readonly { outcome: BenchmarkOutcome }[],
): BenchmarkCounts {
  const counts: BenchmarkCounts = { repos: repos.length, firstTry: 0, afterSetup: 0, unplanned: 0 };
  for (const repo of repos) {
    if (repo.outcome === "first_try") counts.firstTry++;
    else if (repo.outcome === "after_setup") counts.afterSetup++;
    else counts.unplanned++;
  }
  return counts;
}

/** One decimal, matching the eval report. */
export function benchmarkPercent(part: number, whole: number): string {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function benchmarkByCategory(
  repos: readonly { category: BenchmarkCategory; outcome: BenchmarkOutcome }[],
): { id: BenchmarkCategory; label: string; counts: BenchmarkCounts }[] {
  return benchmarkCategories.map((category) => ({
    id: category.id,
    label: category.label,
    counts: countBenchmark(repos.filter((repo) => repo.category === category.id)),
  }));
}
