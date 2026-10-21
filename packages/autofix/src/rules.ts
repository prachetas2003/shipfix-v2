import type { LogDiagnosis } from "@shipfix/adapter-core";
import type { DeploymentPlan } from "@shipfix/contracts";
import type { FileEdit, Fix, FixContext, PlanEdit } from "./types";
import { Overlay } from "./util";
import { fixCorsOrigin } from "./fixers/cors";
import { fixImportCase } from "./fixers/importCase";
import { fixLocalhostApiUrl } from "./fixers/localhostUrl";
import { fixPortBinding } from "./fixers/port";
import { fixSpaFallback } from "./fixers/spaFallback";
import { fixBuildMemory, fixLegacyPeerDeps, fixLockfileInstall } from "./fixers/install";
import { fixMissingDependency, fixMissingScript, fixNodeEngines, fixPrismaGenerate } from "./fixers/packageJson";

type Fixer = (ctx: FixContext) => Promise<Fix | null>;

/** Safe, well-understood problems worth fixing before the first deploy attempt. */
const PREFLIGHT: Fixer[] = [
  fixImportCase,
  fixPortBinding,
  fixPrismaGenerate,
  fixLocalhostApiUrl,
  fixCorsOrigin,
  fixSpaFallback,
];

/** Run every pre-flight fixer; each sees the edits of the ones before it. */
export async function preflightFixes(ctx: FixContext): Promise<Fix[]> {
  const overlay = new Overlay(ctx.files);
  const fixes: Fix[] = [];
  for (const fixer of PREFLIGHT) {
    const fix = await fixer({ ...ctx, files: overlay });
    if (!fix) continue;
    overlay.record(fix.files);
    fixes.push(fix);
  }
  return fixes;
}

/** The rule-based fix for a classified deploy failure, or null when it needs the LLM or the user. */
export async function fixForDiagnosis(ctx: FixContext, diagnosis: LogDiagnosis): Promise<Fix | null> {
  switch (diagnosis.kind) {
    case "import_path_case":
      return fixImportCase(ctx);
    case "no_open_port":
      return fixPortBinding(ctx);
    case "localhost_url":
      return fixLocalhostApiUrl(ctx);
    case "prisma_client":
      return fixPrismaGenerate(ctx);
    case "node_version":
      return fixNodeEngines(ctx, diagnosis.evidence.join("\n"));
    case "missing_module":
      return fixMissingDependency(ctx, diagnosis.subject);
    case "missing_script":
      return fixMissingScript(ctx, diagnosis.subject);
    case "lockfile_mismatch":
      return fixLockfileInstall(ctx);
    case "dependency_conflict":
      return fixLegacyPeerDeps(ctx);
    case "out_of_memory":
      return diagnosis.phase === "build" ? fixBuildMemory(ctx) : null;
    default:
      return null;
  }
}

/** Collapse several fixes into one edit per file (first `before`, last `after`), dropping no-ops. */
export function mergeFileEdits(fixes: Fix[]): FileEdit[] {
  const byPath = new Map<string, FileEdit>();
  for (const edit of fixes.flatMap((f) => f.files)) {
    const prior = byPath.get(edit.path);
    byPath.set(edit.path, { path: edit.path, before: prior ? prior.before : edit.before, after: edit.after });
  }
  return [...byPath.values()].filter((e) => e.before !== e.after);
}

/** Apply plan-level fixes (commands, literal env) to a copy of the plan. */
export function applyPlanEdits(plan: DeploymentPlan, edits: PlanEdit[]): DeploymentPlan {
  const next = structuredClone(plan);
  for (const edit of edits) {
    const service = next.services.find((s) => s.id === edit.serviceId);
    if (!service) continue;
    if ("field" in edit) {
      service[edit.field] = edit.to;
    } else {
      service.env = [
        ...service.env.filter((e) => e.name !== edit.env.name),
        { name: edit.env.name, source: "literal", value: edit.env.value },
      ];
    }
  }
  return next;
}
