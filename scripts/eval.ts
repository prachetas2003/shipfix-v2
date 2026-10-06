/**
 * ShipFix reliability harness.
 *
 * Usage:
 *   pnpm eval run                         # offline: analyze -> deterministic plan -> validate
 *   pnpm eval run -- --llm                # plan out-of-slice repos with the configured LLM
 *   pnpm eval run -- --category lovable --limit 50 --concurrency 6
 *   pnpm eval run -- --baseline eval/reports/latest.json --fail-on-regression
 *   pnpm eval discover -- --per-query 60 --since 2025-06-01   # grow the corpus from GitHub search
 *   pnpm eval prune -- --dry-run          # drop discovered non-apps found by the latest report
 *   SHIPFIX_EVAL_TOKEN=... pnpm eval live -- --api https://api.shipfix.dev --limit 20
 *
 * Env: GITHUB_TOKEN (optional; higher search/clone rate limits),
 *      LLM_* (for --llm), SHIPFIX_EVAL_TOKEN (for live).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Corpus,
  discoverRepos,
  driveLiveRun,
  evaluateCorpus,
  findRegressions,
  loadCorpus,
  mergeCorpus,
  pruneNonApps,
  renderMarkdown,
  summarize,
  summarizeLive,
  type CorpusEntry,
  type EvalReport,
  type LiveRunResult,
} from "../packages/eval/src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const [command = "run", ...rest] = process.argv.slice(2).filter((a) => a !== "--");

function flag(name: string): boolean {
  return rest.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0) return rest[i + 1];
  const inline = rest.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const corpusPath = path.resolve(root, option("corpus") ?? "eval/corpus.json");
const outDir = path.resolve(root, option("out") ?? "eval/reports");

function selectEntries(entries: CorpusEntry[]): CorpusEntry[] {
  const category = option("category");
  const limit = Number(option("limit") ?? Infinity);
  return entries.filter((e) => !category || e.category === category).slice(0, limit);
}

async function writeReport(name: string, json: unknown, markdown?: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(path.join(outDir, `${name}-${stamp}.json`), JSON.stringify(json, null, 2));
  await writeFile(path.join(outDir, `${name}-latest.json`), JSON.stringify(json, null, 2));
  if (markdown) await writeFile(path.join(outDir, `${name}-latest.md`), markdown);
}

async function runOffline(): Promise<void> {
  const corpus = await loadCorpus(corpusPath);
  const entries = selectEntries(corpus.entries);
  const useLlm = flag("llm");
  const gateway = useLlm
    ? (await import("../packages/llm/src/index.js")).createLLMGateway()
    : undefined;

  console.log(`Evaluating ${entries.length} repos (${useLlm ? "llm" : "offline"})...`);
  const results = await evaluateCorpus(entries, {
    gateway,
    concurrency: Number(option("concurrency") ?? 4),
    githubToken: process.env.GITHUB_TOKEN,
    onResult: (r, done) => {
      const verdict = r.status === "ok" ? (r.classification ?? "outside-slice") : r.status;
      console.log(`[${done}/${entries.length}] ${r.id}: ${verdict} (${r.timings.totalMs} ms)`);
    },
  });

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    mode: useLlm ? "llm" : "offline",
    summary: summarize(results),
    results,
  };

  const baselinePath = option("baseline");
  let regressions: ReturnType<typeof findRegressions> = [];
  if (baselinePath) {
    const baseline = JSON.parse(await readFile(path.resolve(root, baselinePath), "utf8")) as EvalReport;
    regressions = findRegressions(baseline.results, results);
  }

  const markdown = renderMarkdown(report, regressions);
  await writeReport(`eval-${report.mode}`, report, markdown);
  console.log(`\n${markdown}`);

  const missed = results.filter((r) => r.expectationMet === false).length;
  if (flag("fail-on-regression") && (regressions.length > 0 || missed > 0)) {
    console.error(`Failing: ${regressions.length} regression(s), ${missed} expectation miss(es).`);
    process.exit(1);
  }
}

async function runDiscover(): Promise<void> {
  const raw = Corpus.parse(JSON.parse(await readFile(corpusPath, "utf8")));
  const discovered = await discoverRepos({
    token: process.env.GITHUB_TOKEN,
    perQuery: Number(option("per-query") ?? 60),
    pushedSince: option("since"),
  });
  const { corpus, added } = mergeCorpus(raw, discovered);
  await writeFile(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`Discovered ${discovered.length} repos, added ${added}. Corpus now has ${corpus.entries.length}.`);
}

async function runPrune(): Promise<void> {
  const reportPath = path.resolve(root, option("report") ?? "eval/reports/eval-offline-latest.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as EvalReport;
  const raw = Corpus.parse(JSON.parse(await readFile(corpusPath, "utf8")));
  const { corpus, removed } = pruneNonApps(raw, report.results);
  if (flag("dry-run")) {
    for (const id of removed) console.log(`would remove ${id}`);
  } else {
    await writeFile(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  console.log(`${flag("dry-run") ? "Would prune" : "Pruned"} ${removed.length} non-app repos. Corpus now has ${corpus.entries.length}.`);
}

async function runLive(): Promise<void> {
  const apiUrl = option("api");
  const token = process.env.SHIPFIX_EVAL_TOKEN;
  if (!apiUrl || !token) {
    console.error("live mode needs --api <url> and SHIPFIX_EVAL_TOKEN.");
    process.exit(2);
  }
  const corpus = await loadCorpus(corpusPath);
  const entries = selectEntries(corpus.entries).filter((e) => e.repo);
  const results: LiveRunResult[] = [];
  for (const [i, entry] of entries.entries()) {
    const r = await driveLiveRun(entry.repo!, {
      apiUrl,
      token,
      timeoutMs: Number(option("timeout-minutes") ?? 30) * 60_000,
    });
    results.push(r);
    console.log(`[${i + 1}/${entries.length}] ${r.id}: ${r.outcome} in ${Math.round(r.durationMs / 1000)}s`);
  }
  const summary = summarizeLive(results);
  await writeReport("eval-live", { generatedAt: new Date().toISOString(), summary, results });
  console.log(JSON.stringify(summary, null, 2));
}

const commands: Record<string, () => Promise<void>> = {
  run: runOffline,
  discover: runDiscover,
  prune: runPrune,
  live: runLive,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command "${command}". Use: run | discover | prune | live`);
  process.exit(2);
}
await handler();
