import { diagnoseLogs, tailLines, type LogDiagnosis, type LogFailureKind } from "@shipfix/adapter-core";
import { parseStructured, type LLMGateway } from "@shipfix/llm";
import type { FileEdit, FixService, PlanEdit, RepoFiles } from "../types";
import { fixForDiagnosis } from "../rules";
import { applyProposedEdits } from "./edits";
import { selectContextFiles } from "./context";
import { buildRepairRequest, RepairResponse, type PriorAttempt } from "./prompt";

/** A writable checkout of the repo plus a way to build it like the host would. */
export interface RepairWorkspace extends RepoFiles {
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Install and build (and smoke-start when relevant) with these commands and non-secret env. */
  verify(service: FixService, env: Record<string, string>): Promise<{ ok: boolean; log: string }>;
}

export interface RepairAttempt {
  source: "rule" | "llm";
  title: string;
  files: string[];
  outcome: "passed" | "progress" | "failed" | "rejected";
  detail: string;
}

export type RepairOutcome =
  | {
      status: "fixed";
      title: string;
      explanation: string;
      files: FileEdit[];
      plan: PlanEdit[];
      attempts: RepairAttempt[];
      /** True when the sandbox build passed outright; false when it stopped only on env the sandbox never has. */
      fullyVerified: boolean;
    }
  | { status: "needs_user"; message: string; attempts: RepairAttempt[] }
  | { status: "gave_up"; reason: string; attempts: RepairAttempt[] };

export interface RepairOptions {
  workspace: RepairWorkspace;
  service: FixService;
  diagnosis: LogDiagnosis;
  log: string;
  /** Non-secret env the build may read (plan literals). */
  env?: Record<string, string>;
  llm?: LLMGateway | null;
  maxAttempts?: number;
  deadline?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  onAttempt?: (attempt: RepairAttempt, index: number) => void | Promise<void>;
}

/** Failures the sandbox can't get past because it never holds the app's secrets. */
const SANDBOX_ENV_KINDS: ReadonlySet<LogFailureKind> = new Set(["missing_env", "db_unreachable"]);

interface Candidate {
  source: "rule" | "llm";
  title: string;
  explanation: string;
  files: FileEdit[];
  plan: PlanEdit[];
}

function applyPlanToService(service: FixService, env: Record<string, string>, plan: PlanEdit[]) {
  const next = { ...service };
  const nextEnv = { ...env };
  for (const e of plan) {
    if (e.serviceId !== service.id) continue;
    if ("field" in e) next[e.field] = e.to;
    else nextEnv[e.env.name] = e.env.value;
  }
  return { service: next, env: nextEnv };
}

function sameFailure(a: LogDiagnosis, b: LogDiagnosis): boolean {
  return a.kind === b.kind && (a.subject ?? null) === (b.subject ?? null);
}

/**
 * Fix a failed deploy: a rule-based fix when one applies, otherwise the model,
 * each candidate rebuilt in the sandbox before it is accepted. Edits that make
 * progress (a different error) are kept; edits that change nothing are undone.
 */
export async function runRepairLoop(opts: RepairOptions): Promise<RepairOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const now = opts.now ?? Date.now;
  const attempts: RepairAttempt[] = [];
  const prior: PriorAttempt[] = [];
  const kept = new Map<string, FileEdit>();
  const keptPlan: PlanEdit[] = [];
  const titles: string[] = [];
  const explanations: string[] = [];
  const triedRules = new Set<string>();
  let diagnosis = opts.diagnosis;
  let log = opts.log;

  const record = async (a: RepairAttempt) => {
    attempts.push(a);
    await opts.onAttempt?.(a, attempts.length - 1);
  };

  /** Undo partial progress so a failed repair leaves the checkout as it found it. */
  const revertKept = async () => {
    for (const f of kept.values()) {
      if (f.before !== null) await opts.workspace.writeFile(f.path, f.before);
      else await opts.workspace.deleteFile(f.path);
    }
    kept.clear();
  };

  const finish = (fullyVerified: boolean): RepairOutcome => ({
    status: "fixed",
    title: titles.length === 1 ? titles[0]! : `Fix ${titles.length} deploy problems`,
    explanation: explanations.join("\n\n"),
    files: [...kept.values()].filter((e) => e.before !== e.after),
    plan: keptPlan,
    attempts,
    fullyVerified,
  });

  for (let n = 0; n < maxAttempts; n++) {
    if (opts.deadline && now() > opts.deadline) break;
    const current = applyPlanToService(opts.service, opts.env ?? {}, keptPlan);

    let candidate: Candidate | null = null;
    const ruleKey = `${diagnosis.kind}:${diagnosis.subject ?? ""}`;
    if (!triedRules.has(ruleKey)) {
      triedRules.add(ruleKey);
      const fix = await fixForDiagnosis(
        { files: opts.workspace, service: current.service, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
        diagnosis,
      );
      if (fix) candidate = { source: "rule", title: fix.title, explanation: fix.explanation, files: fix.files, plan: fix.plan };
    }

    if (!candidate) {
      if (diagnosis.fixOwner === "user") {
        await revertKept();
        return { status: "needs_user", message: diagnosis.explanation, attempts };
      }
      if (!opts.llm) break;
      const files = await selectContextFiles(opts.workspace, current.service, diagnosis, log);
      const logTail = tailLines(log.split("\n"), 150, 12_000);
      let text: string;
      try {
        text = (await opts.llm.complete(buildRepairRequest({ service: current.service, diagnosis, logTail, files, prior }))).text;
      } catch (e) {
        await revertKept();
        return { status: "gave_up", reason: `The repair model was unavailable: ${e instanceof Error ? e.message : String(e)}`, attempts };
      }
      const parsed = parseStructured(text, RepairResponse);
      if (!parsed.ok) {
        prior.push({ summary: "Response was not valid JSON for the schema.", result: parsed.error });
        await record({ source: "llm", title: "Unusable model response", files: [], outcome: "rejected", detail: parsed.error });
        continue;
      }
      if (!parsed.data.canFix) {
        await revertKept();
        return { status: "needs_user", message: parsed.data.needsFromUser || parsed.data.explanation, attempts };
      }
      const applied = await applyProposedEdits(opts.workspace, parsed.data.edits);
      if (!applied.ok) {
        prior.push({ summary: parsed.data.explanation, result: `Edits could not be applied: ${applied.error}` });
        await record({ source: "llm", title: "Edits could not be applied", files: parsed.data.edits.map((e) => e.path), outcome: "rejected", detail: applied.error });
        continue;
      }
      candidate = { source: "llm", title: diagnosis.title || "Fix the build", explanation: parsed.data.explanation, files: applied.files, plan: [] };
    }

    for (const f of candidate.files) await opts.workspace.writeFile(f.path, f.after);
    const trial = applyPlanToService(opts.service, opts.env ?? {}, [...keptPlan, ...candidate.plan]);
    const result = await opts.workspace.verify(trial.service, trial.env);
    const next = result.ok ? null : diagnoseLogs(result.log);
    const paths = candidate.files.map((f) => f.path);

    const keep = () => {
      for (const f of candidate!.files) {
        const prev = kept.get(f.path);
        kept.set(f.path, { path: f.path, before: prev ? prev.before : f.before, after: f.after });
      }
      keptPlan.push(...candidate!.plan);
      titles.push(candidate!.title);
      explanations.push(candidate!.explanation);
    };

    if (!next) {
      keep();
      await record({ source: candidate.source, title: candidate.title, files: paths, outcome: "passed", detail: "Sandbox build passed." });
      return finish(true);
    }
    if (SANDBOX_ENV_KINDS.has(next.kind) && !SANDBOX_ENV_KINDS.has(diagnosis.kind)) {
      keep();
      await record({ source: candidate.source, title: candidate.title, files: paths, outcome: "passed", detail: `Build got past the original error and stopped on ${next.kind}, which needs the app's real settings.` });
      return finish(false);
    }
    if (!sameFailure(next, diagnosis) && next.kind !== "unknown") {
      keep();
      prior.push({ summary: candidate.explanation, result: `Fixed that, then hit a new error: ${next.title}` });
      await record({ source: candidate.source, title: candidate.title, files: paths, outcome: "progress", detail: `New error: ${next.title}` });
      diagnosis = next;
      log = result.log;
      continue;
    }

    for (const f of candidate.files) {
      const restore = kept.get(f.path)?.after ?? f.before;
      if (restore !== null) await opts.workspace.writeFile(f.path, restore);
      else await opts.workspace.deleteFile(f.path);
    }
    prior.push({ summary: candidate.explanation, result: `Same failure after the change: ${next.evidence.slice(-3).join(" | ") || next.title}` });
    await record({ source: candidate.source, title: candidate.title, files: paths, outcome: "failed", detail: next.title });
  }

  await revertKept();
  return {
    status: "gave_up",
    reason: attempts.length
      ? `ShipFix tried ${attempts.length} fix${attempts.length === 1 ? "" : "es"} but the build still fails: ${diagnosis.title}`
      : `No automatic fix is available for this failure: ${diagnosis.title}`,
    attempts,
  };
}
