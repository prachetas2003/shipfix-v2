import type { PlanClassification } from "@shipfix/contracts";
import type { RepoEvalResult, RepoShape } from "./evaluate";

export interface Count {
  key: string;
  count: number;
}

export interface EvalSummary {
  total: number;
  cloned: number;
  analyzed: number;
  /** Share of analyzed repos with a plan ShipFix would auto-deploy right now. */
  deployableRate: number;
  /** deployable + needs_setup: live after the user answers questions. */
  actionableRate: number;
  diagnoseRate: number;
  /** Offline runs only: repos outside the deterministic slice (would need the LLM). */
  unplannedRate: number;
  deterministicRate: number;
  classifications: Record<PlanClassification | "none", number>;
  statuses: Record<string, number>;
  topIssueCodes: Count[];
  /** Env vars users are most often asked for — candidates for auto-provisioning. */
  topSecretNames: Count[];
  /** Median number of values a needs_setup plan asks the user for. */
  medianSecretsPerSetupPlan: number;
  /** Most common repo shapes ShipFix cannot deploy yet — the coverage backlog. */
  topUncoveredShapes: Count[];
  byCategory: { category: string; total: number; deployable: number; actionable: number }[];
  expectations: { checked: number; met: number };
  timings: { analyzeP50Ms: number; analyzeP95Ms: number; totalP50Ms: number; totalP95Ms: number };
}

export interface EvalReport {
  generatedAt: string;
  mode: "offline" | "llm";
  summary: EvalSummary;
  results: RepoEvalResult[];
}

const RANK: Record<PlanClassification | "none", number> = {
  deployable: 3,
  needs_setup: 2,
  diagnose_only: 1,
  none: 0,
};

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function topCounts(keys: string[], limit: number): Count[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** Stable, human-readable signature like `next(fullstack)+express(backend) [postgres]`. */
export function shapeSignature(shape: RepoShape): string {
  const services = shape.services.length
    ? shape.services
        .map((s) => `${s.framework === "unknown" ? s.language : s.framework}(${s.role})`)
        .sort()
        .join("+")
    : "no-services";
  const data = shape.dataNeeds.length ? ` [${[...shape.dataNeeds].sort().join(",")}]` : "";
  return services + data;
}

export function summarize(results: RepoEvalResult[]): EvalSummary {
  const analyzed = results.filter((r) => r.status === "ok" || r.status === "plan_failed");
  const classifications: EvalSummary["classifications"] = {
    deployable: 0,
    needs_setup: 0,
    diagnose_only: 0,
    none: 0,
  };
  for (const r of analyzed) classifications[r.classification ?? "none"]++;

  const statuses: Record<string, number> = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

  const uncovered = analyzed.filter(
    (r) => r.shape && r.classification !== "deployable" && r.classification !== "needs_setup",
  );

  const categories = new Map<string, { total: number; deployable: number; actionable: number }>();
  for (const r of results) {
    const c = categories.get(r.category) ?? { total: 0, deployable: 0, actionable: 0 };
    c.total++;
    if (r.classification === "deployable") c.deployable++;
    if (r.classification === "deployable" || r.classification === "needs_setup") c.actionable++;
    categories.set(r.category, c);
  }

  const checked = results.filter((r) => r.expectationMet !== null);

  return {
    total: results.length,
    cloned: results.filter((r) => r.status !== "clone_failed").length,
    analyzed: analyzed.length,
    deployableRate: ratio(classifications.deployable, analyzed.length),
    actionableRate: ratio(classifications.deployable + classifications.needs_setup, analyzed.length),
    diagnoseRate: ratio(classifications.diagnose_only, analyzed.length),
    unplannedRate: ratio(classifications.none, analyzed.length),
    deterministicRate: ratio(analyzed.filter((r) => r.planSource === "deterministic").length, analyzed.length),
    classifications,
    statuses,
    topIssueCodes: topCounts(analyzed.flatMap((r) => r.issueCodes), 15),
    topSecretNames: topCounts(analyzed.flatMap((r) => r.secretNames ?? []), 25),
    medianSecretsPerSetupPlan: percentile(
      analyzed.filter((r) => r.classification === "needs_setup").map((r) => (r.secretNames ?? []).length),
      50,
    ),
    topUncoveredShapes: topCounts(uncovered.map((r) => shapeSignature(r.shape!)), 15),
    byCategory: [...categories.entries()]
      .map(([category, c]) => ({ category, ...c }))
      .sort((a, b) => b.total - a.total),
    expectations: { checked: checked.length, met: checked.filter((r) => r.expectationMet).length },
    timings: {
      analyzeP50Ms: percentile(analyzed.map((r) => r.timings.analyzeMs), 50),
      analyzeP95Ms: percentile(analyzed.map((r) => r.timings.analyzeMs), 95),
      totalP50Ms: percentile(results.map((r) => r.timings.totalMs), 50),
      totalP95Ms: percentile(results.map((r) => r.timings.totalMs), 95),
    },
  };
}

export interface Regression {
  id: string;
  before: PlanClassification | "none";
  after: PlanClassification | "none";
}

/**
 * Repos whose classification got worse versus a baseline report. Only repos
 * that analyzed in both runs count, so a flaky clone isn't a regression.
 */
export function findRegressions(baseline: RepoEvalResult[], current: RepoEvalResult[]): Regression[] {
  const before = new Map(baseline.filter((r) => r.status === "ok").map((r) => [r.id, r]));
  const out: Regression[] = [];
  for (const r of current) {
    const prev = before.get(r.id);
    if (!prev || r.status === "clone_failed") continue;
    const b = prev.classification ?? "none";
    const a = r.status === "ok" ? (r.classification ?? "none") : "none";
    if (RANK[a] < RANK[b]) out.push({ id: r.id, before: b, after: a });
  }
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: EvalReport, regressions: Regression[] = []): string {
  const s = report.summary;
  const lines: string[] = [
    `# ShipFix eval — ${report.generatedAt}`,
    "",
    `Mode: **${report.mode}** · Repos: **${s.total}** · Cloned: ${s.cloned} · Analyzed: ${s.analyzed}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Deployable first try | ${pct(s.deployableRate)} |`,
    `| Deployable after setup questions | ${pct(s.actionableRate)} |`,
    `| Diagnose only | ${pct(s.diagnoseRate)} |`,
    ...(report.mode === "offline" ? [`| Outside deterministic slice (needs LLM) | ${pct(s.unplannedRate)} |`] : []),
    `| Planned deterministically | ${pct(s.deterministicRate)} |`,
    `| Analyze p50 / p95 | ${s.timings.analyzeP50Ms} ms / ${s.timings.analyzeP95Ms} ms |`,
    `| Expectations met | ${s.expectations.met}/${s.expectations.checked} |`,
    "",
  ];
  if (regressions.length) {
    lines.push("## Regressions vs baseline", "");
    for (const r of regressions) lines.push(`- \`${r.id}\`: ${r.before} → ${r.after}`);
    lines.push("");
  }
  if (s.topUncoveredShapes.length) {
    lines.push("## Top shapes ShipFix can't deploy yet", "");
    for (const c of s.topUncoveredShapes) lines.push(`- ${c.count} × \`${c.key}\``);
    lines.push("");
  }
  if (s.topSecretNames.length) {
    lines.push(
      "## Values users are asked for most",
      "",
      `Median per setup plan: ${s.medianSecretsPerSetupPlan}`,
      "",
    );
    for (const c of s.topSecretNames) lines.push(`- ${c.count} × \`${c.key}\``);
    lines.push("");
  }
  if (s.topIssueCodes.length) {
    lines.push("## Top validator issues", "");
    for (const c of s.topIssueCodes) lines.push(`- ${c.count} × \`${c.key}\``);
    lines.push("");
  }
  lines.push("## By category", "", "| Category | Repos | Deployable | After setup |", "| --- | --- | --- | --- |");
  for (const c of s.byCategory) {
    lines.push(`| ${c.category} | ${c.total} | ${c.deployable} | ${c.actionable} |`);
  }
  const failures = report.results.filter((r) => r.status !== "ok");
  if (failures.length) {
    lines.push("", "## Pipeline failures", "");
    for (const r of failures.slice(0, 50)) lines.push(`- \`${r.id}\` ${r.status}: ${r.error ?? ""}`);
  }
  const missed = report.results.filter((r) => r.expectationMet === false);
  if (missed.length) {
    lines.push("", "## Expectation misses", "");
    for (const r of missed) lines.push(`- \`${r.id}\`: expected ${r.expect}, got ${r.classification ?? "none"}`);
  }
  lines.push("");
  return lines.join("\n");
}
