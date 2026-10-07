import { analyzeRepo, createLocalFsRepoSource } from "@shipfix/analyzer";
import type { DeploymentPlan, PlanClassification, RepoContext } from "@shipfix/contracts";
import type { LLMGateway } from "@shipfix/llm";
import { generatePlan, synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan, type Capabilities } from "@shipfix/validator";
import { shallowClone, type ClonedRepo } from "./clone";
import { entryId, type CorpusEntry } from "./corpus";

/**
 * What ShipFix can deploy when a user has connected every supported provider.
 * Mirrors the adapter/provisioner registries the worker loads; the eval measures
 * product coverage, not a specific user's connected accounts.
 */
export const FULL_CAPABILITIES: Capabilities = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api", "python_api", "docker_service", "worker"] },
  ["neon", "upstash"],
  ["supabase"],
);

export type EvalStatus = "ok" | "clone_failed" | "analyze_failed" | "plan_failed";

/** `none` = offline run and the repo is outside the deterministic slice. */
export type EvalPlanSource = "deterministic" | "llm" | "llm_fallback" | "none";

export interface RepoShape {
  services: { rootDir: string; language: string; framework: string; role: string }[];
  dataNeeds: string[];
  monorepoTool: string;
  envRefCount: number;
  hardcodedUrlCount: number;
  fileCount: number;
}

export interface RepoEvalResult {
  id: string;
  category: string;
  status: EvalStatus;
  error?: string;
  commitSha?: string;
  shape?: RepoShape;
  planSource: EvalPlanSource;
  /** null when no plan exists (offline run, outside the deterministic slice). */
  classification: PlanClassification | null;
  issueCodes: string[];
  blockerTitles: string[];
  questionCount: number;
  /** Env var NAMES the user would be asked to supply (never values). */
  secretNames: string[];
  expect?: PlanClassification;
  /** null when the entry has no expectation or no plan was produced. */
  expectationMet: boolean | null;
  timings: { cloneMs: number; analyzeMs: number; planMs: number; validateMs: number; totalMs: number };
}

export interface EvaluateOptions {
  /** When set, repos outside the deterministic slice are planned by the LLM. */
  gateway?: LLMGateway;
  capabilities?: Capabilities;
  cloneTimeoutMs?: number;
  githubToken?: string;
  /** Test seam: replaces git clone. */
  clone?: (entry: CorpusEntry) => Promise<ClonedRepo>;
}

export function shapeOf(ctx: RepoContext): RepoShape {
  return {
    services: ctx.services.map((s) => ({
      rootDir: s.rootDir,
      language: s.language,
      framework: s.framework,
      role: s.role,
    })),
    dataNeeds: [...new Set(ctx.dataNeeds.map((d) => (d.hostedBy ? `${d.kind}@${d.hostedBy}` : d.kind)))],
    monorepoTool: ctx.monorepoTool,
    envRefCount: ctx.envRefs.length,
    hardcodedUrlCount: ctx.hardcodedUrls.length,
    fileCount: ctx.fileTree.length,
  };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function planFor(
  ctx: RepoContext,
  gateway: LLMGateway | undefined,
): Promise<{ plan: DeploymentPlan | null; source: EvalPlanSource }> {
  if (gateway) {
    const result = await generatePlan(ctx, gateway);
    return { plan: result.plan, source: result.usedFallback ? "llm_fallback" : result.planSource };
  }
  const plan = synthesizeDeterministicPlan(ctx);
  return { plan, source: plan ? "deterministic" : "none" };
}

async function localRepo(entry: CorpusEntry): Promise<ClonedRepo> {
  return { dir: entry.path!, commitSha: "0".repeat(40), cleanup: async () => {} };
}

/**
 * Run one corpus entry through the real ShipFix pipeline — analyze, plan,
 * validate — exactly as the worker does, minus provider calls. Never throws:
 * every failure becomes a result row so one bad repo can't sink the report.
 */
export async function evaluateEntry(entry: CorpusEntry, opts: EvaluateOptions = {}): Promise<RepoEvalResult> {
  const started = Date.now();
  const result: RepoEvalResult = {
    id: entryId(entry),
    category: entry.category,
    status: "ok",
    planSource: "none",
    classification: null,
    issueCodes: [],
    blockerTitles: [],
    questionCount: 0,
    secretNames: [],
    expect: entry.expect,
    expectationMet: null,
    timings: { cloneMs: 0, analyzeMs: 0, planMs: 0, validateMs: 0, totalMs: 0 },
  };
  const finish = () => {
    result.timings.totalMs = Date.now() - started;
    return result;
  };

  let repo: ClonedRepo;
  const cloneStart = Date.now();
  try {
    if (entry.path) repo = await localRepo(entry);
    else if (opts.clone) repo = await opts.clone(entry);
    else {
      repo = await shallowClone(entry.repo!, {
        ref: entry.ref,
        timeoutMs: opts.cloneTimeoutMs,
        token: opts.githubToken,
      });
    }
  } catch (err) {
    result.status = "clone_failed";
    result.error = errorMessage(err);
    return finish();
  } finally {
    result.timings.cloneMs = Date.now() - cloneStart;
  }
  result.commitSha = repo.commitSha;

  try {
    const analyzeStart = Date.now();
    let ctx: RepoContext;
    try {
      ctx = await analyzeRepo(createLocalFsRepoSource(repo.dir), {
        repoFullName: entry.repo ?? entryId(entry),
        commitSha: repo.commitSha,
      });
    } catch (err) {
      result.status = "analyze_failed";
      result.error = errorMessage(err);
      return finish();
    } finally {
      result.timings.analyzeMs = Date.now() - analyzeStart;
    }
    result.shape = shapeOf(ctx);

    const planStart = Date.now();
    let planned: { plan: DeploymentPlan | null; source: EvalPlanSource };
    try {
      planned = await planFor(ctx, opts.gateway);
    } catch (err) {
      result.status = "plan_failed";
      result.error = errorMessage(err);
      return finish();
    } finally {
      result.timings.planMs = Date.now() - planStart;
    }
    result.planSource = planned.source;
    if (!planned.plan) return finish();

    const validateStart = Date.now();
    const validated = validatePlan(planned.plan, ctx, opts.capabilities ?? FULL_CAPABILITIES);
    result.timings.validateMs = Date.now() - validateStart;

    result.classification = validated.plan.classification;
    result.issueCodes = [...new Set(validated.issues.map((i) => i.code))].sort();
    result.blockerTitles = validated.plan.blockers.map((b) => b.title);
    result.questionCount = validated.plan.questions.length;
    result.secretNames = [
      ...new Set(
        validated.plan.services.flatMap((s) => s.env.filter((e) => e.source === "user_secret").map((e) => e.name)),
      ),
    ].sort();
    if (entry.expect) result.expectationMet = entry.expect === result.classification;
    return finish();
  } finally {
    await repo.cleanup().catch(() => {});
  }
}

/** Evaluate many entries with bounded concurrency, preserving corpus order. */
export async function evaluateCorpus(
  entries: CorpusEntry[],
  opts: EvaluateOptions & { concurrency?: number; onResult?: (r: RepoEvalResult, done: number) => void } = {},
): Promise<RepoEvalResult[]> {
  const results: RepoEvalResult[] = new Array(entries.length);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < entries.length) {
      const i = next++;
      results[i] = await evaluateEntry(entries[i], opts);
      done++;
      opts.onResult?.(results[i], done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}
