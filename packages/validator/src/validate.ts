import type {
  DeploymentPlan,
  EnvVar,
  PlanClassification,
  PlanService,
  RepoContext,
  WiringEdge,
} from "@shipfix/contracts";
import { redact } from "@shipfix/secrets";
import type { Capabilities } from "./capabilities";
import { issueToBlocker, type ValidationIssue } from "./issues";
import { isManagedSupported, isServiceTypeSupported, MVP_SUPPORT_SUMMARY } from "./mvpSupport";
import {
  capConfidenceForVerification,
  checkVerificationGrounding,
} from "./verificationGrounding";

export interface ValidationResult {
  /** The plan with classification downgraded + validation blockers appended. */
  plan: DeploymentPlan;
  /** Every deterministic finding (for run events / debugging). */
  issues: ValidationIssue[];
}

const CLASSES = ["deployable", "needs_setup", "diagnose_only"] as const;
const RANK: Record<PlanClassification, number> = {
  deployable: 0,
  needs_setup: 1,
  diagnose_only: 2,
};
const sevRank = (s: ValidationIssue["severity"]): number =>
  s === "fatal" ? 2 : s === "needs_input" ? 1 : 0;

/** Does `rootDir` correspond to something real in the repo? */
function rootExists(rootDir: string, ctx: RepoContext): boolean {
  if (rootDir === "") return true;
  if (ctx.services.some((s) => s.rootDir === rootDir)) return true;
  return ctx.fileTree.some((f) => f === rootDir || f.startsWith(`${rootDir}/`));
}

/**
 * If a command is an npm-script invocation, return the script name so we can
 * verify it exists. Returns null for opaque commands (binaries, file paths) we
 * cannot disprove — those are left alone rather than flagged as false positives.
 */
const DIRECT_SCRIPTS = new Set(["start", "build", "dev", "preview", "serve", "test", "lint"]);
function scriptName(command: string): string | null {
  const run = command.match(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/);
  if (run) return run[1];
  const direct = command.match(/\b(?:npm|pnpm|yarn|bun)\s+([\w:.-]+)/);
  if (direct && DIRECT_SCRIPTS.has(direct[1])) return direct[1];
  return null;
}

function checkCommand(
  service: PlanService,
  command: string | null,
  kind: "install" | "build" | "start",
  scriptsByRoot: Map<string, Record<string, string>>,
  add: (i: ValidationIssue) => void,
): void {
  if (!command) return;
  const script = scriptName(command);
  if (!script) return; // opaque command — cannot disprove, don't flag
  const scripts = scriptsByRoot.get(service.rootDir);
  if (scripts && !(script in scripts)) {
    add({
      code: `${kind}_command_ungrounded`,
      severity: "fatal",
      message: `Service "${service.id}" ${kind} command runs script "${script}", which is not defined in ${service.rootDir || "/"}/package.json.`,
      path: `services.${service.id}`,
    });
  }
}

function hasScript(ctx: RepoContext, rootDir: string, script: string): boolean {
  return Boolean(ctx.services.find((s) => s.rootDir === rootDir)?.scripts?.[script]);
}

function checkEnvVar(
  service: PlanService,
  env: EnvVar,
  serviceIds: Set<string>,
  managedIds: Set<string>,
  add: (i: ValidationIssue) => void,
): void {
  const path = `services.${service.id}.env.${env.name}`;
  if (env.source === "literal") {
    if (env.value == null || env.value === "") {
      add({ code: "env_literal_missing_value", severity: "fatal", message: `Literal env "${env.name}" on "${service.id}" has no value.`, path });
    } else if (redact(env.value) !== env.value) {
      add({ code: "env_literal_secret_shaped", severity: "fatal", message: `Literal env "${env.name}" on "${service.id}" looks like a secret value and must not be embedded in the plan.`, path });
    }
    return;
  }
  if (env.source === "generated_from_service" || env.source === "generated_from_managed") {
    const ref = env.ref ?? "";
    const [refId, field] = ref.split(".");
    const validPool = env.source === "generated_from_service" ? serviceIds : managedIds;
    const validField =
      env.source === "generated_from_service"
        ? field === "publicUrl" || field === "origin"
        : field === "connectionUrl";
    if (!refId || !validPool.has(refId) || !validField) {
      add({
        code: "env_ref_unresolved",
        severity: "fatal",
        message: `Generated env "${env.name}" on "${service.id}" references "${ref || "(empty)"}", which does not resolve to a valid ${env.source === "generated_from_service" ? "service.publicUrl/origin" : "managed.connectionUrl"}.`,
        path,
      });
    }
  }
}

function generatedEnvWiringEdge(service: PlanService, env: EnvVar): WiringEdge | null {
  if (env.source !== "generated_from_service" && env.source !== "generated_from_managed") return null;
  const [refId, field] = (env.ref ?? "").split(".");
  if (!refId || !field) return null;
  if (env.source === "generated_from_service" && field !== "publicUrl" && field !== "origin") return null;
  if (env.source === "generated_from_managed" && field !== "connectionUrl") return null;
  return {
    fromServiceId: refId,
    fromField: field as WiringEdge["fromField"],
    toServiceId: service.id,
    toEnvName: env.name,
  };
}

function wiringKey(edge: WiringEdge): string {
  return `${edge.fromServiceId}.${edge.fromField}->${edge.toServiceId}.${edge.toEnvName}`;
}

/**
 * Deterministically validate an AI-proposed DeploymentPlan against RepoContext
 * evidence and the system's real capabilities. NEVER deploys, never executes
 * repo code. Downgrades classification toward `diagnose_only` and appends
 * blockers; it never removes the planner's blockers or questions.
 */
export function validatePlan(
  plan: DeploymentPlan,
  ctx: RepoContext,
  caps: Capabilities,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (i: ValidationIssue): void => void issues.push(i);

  const serviceIds = new Set(plan.services.map((s) => s.id));
  const managedIds = new Set(plan.managed.map((m) => m.id));
  const allIds = new Set([...serviceIds, ...managedIds]);
  const scriptsByRoot = new Map(ctx.services.map((s) => [s.rootDir, s.scripts]));

  // ── Services exist + commands grounded + env refs valid ───────────────────
  for (const svc of plan.services) {
    if (!rootExists(svc.rootDir, ctx)) {
      add({ code: "service_root_unknown", severity: "fatal", message: `Service "${svc.id}" points to rootDir "${svc.rootDir}", which is not present in the repository.`, path: `services.${svc.id}` });
    }
    checkCommand(svc, svc.install, "install", scriptsByRoot, add);
    checkCommand(svc, svc.build, "build", scriptsByRoot, add);
    checkCommand(svc, svc.start, "start", scriptsByRoot, add);
    if (svc.type === "frontend_static" && !svc.build && !hasScript(ctx, svc.rootDir, "build")) {
      add({
        code: "frontend_build_missing",
        severity: "fatal",
        message: `Frontend "${svc.id}" has no grounded build script. ShipFix needs a reproducible static build before it can deploy to Vercel.`,
        path: `services.${svc.id}.build`,
      });
    }
    if (svc.type === "node_api" && !svc.start && !hasScript(ctx, svc.rootDir, "start")) {
      add({
        code: "backend_start_missing",
        severity: "fatal",
        message: `Backend "${svc.id}" has no grounded start script. ShipFix needs a start command before it can deploy to Render.`,
        path: `services.${svc.id}.start`,
      });
    }
    for (const env of svc.env) checkEnvVar(svc, env, serviceIds, managedIds, add);
  }

  for (const signal of ctx.services) {
    if (signal.language === "python") {
      add({
        code: "repo_python_unsupported",
        severity: "fatal",
        message: `Detected a Python${signal.framework ? `/${signal.framework}` : ""} service at "${signal.rootDir || "/"}". ShipFix does not auto-deploy Python/FastAPI apps in this MVP.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.language === "docker" || signal.framework === "docker-compose") {
      add({
        code: "repo_docker_unsupported",
        severity: "fatal",
        message: `Detected a Docker-based service at "${signal.rootDir || "/"}". ShipFix does not auto-deploy Docker-only or docker-compose apps in this MVP.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.framework === "next" || signal.role === "fullstack") {
      add({
        code: "repo_ssr_unsupported",
        severity: "fatal",
        message: `Detected ${signal.framework} / SSR-style app at "${signal.rootDir || "/"}". ShipFix does not auto-deploy Next.js/SSR apps in this MVP.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.role === "unknown") {
      add({
        code: "repo_unknown_framework",
        severity: "fatal",
        message: `ShipFix could not identify a supported app framework at "${signal.rootDir || "/"}". Supported alpha path is Vite/static frontend plus Express/Fastify/Node API.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    }
  }

  if (plan.classification !== "diagnose_only" && plan.services.length === 0) {
    add({ code: "no_services", severity: "fatal", message: "Plan is not diagnose_only but defines no services." });
  }

  // ── MVP support boundary (independent of user connections) ─────────────────
  // Anything outside the proven slice is RED: diagnosed, not auto-deployed.
  for (const svc of plan.services) {
    if (!isServiceTypeSupported(svc.provider, svc.type)) {
      add({
        code: "service_unsupported_mvp",
        severity: "fatal",
        message: `ShipFix can't auto-deploy "${svc.id}" yet: ${svc.type} on ${svc.provider} is outside the supported slice (${MVP_SUPPORT_SUMMARY}). ShipFix will diagnose it instead of deploying.`,
        path: `services.${svc.id}`,
      });
    }
  }
  for (const m of plan.managed) {
    if (m.mode === "provision" && m.provider && !isManagedSupported(m.provider, m.kind)) {
      add({
        code: "managed_unsupported_mvp",
        severity: "fatal",
        message: `ShipFix can't provision "${m.id}" yet: ${m.kind} on ${m.provider} is outside the supported slice (${MVP_SUPPORT_SUMMARY}).`,
        path: `managed.${m.id}`,
      });
    }
  }

  // ── Env coverage: required repo env refs must be provided by the plan ──────
  const planEnvNames = new Set<string>();
  for (const s of plan.services) for (const e of s.env) planEnvNames.add(e.name);
  for (const m of plan.managed) if (m.exposesEnv) planEnvNames.add(m.exposesEnv);
  for (const w of plan.wiring) if (w.toEnvName) planEnvNames.add(w.toEnvName);
  for (const ref of ctx.envRefs) {
    if (ref.required && !planEnvNames.has(ref.name)) {
      add({
        code: "env_ref_uncovered",
        severity: "needs_input",
        message: `Required environment variable "${ref.name}" was detected in the repo but is not provided by the plan. The app may not run until it is supplied.`,
        path: `services`,
      });
    }
  }

  // Normalize first-class wiring edges for valid generated env refs. The deploy
  // resolver uses env.ref as source of truth; this keeps the plan graph and UI
  // equally explicit.
  const existingWiring = new Set(plan.wiring.map(wiringKey));
  for (const s of plan.services) {
    for (const e of s.env) {
      const edge = generatedEnvWiringEdge(s, e);
      if (edge && !existingWiring.has(wiringKey(edge))) {
        plan.wiring.push(edge);
        existingWiring.add(wiringKey(edge));
      }
    }
  }

  // ── Generated env vars should have a matching wiring edge ──────────────────
  for (const s of plan.services) {
    for (const e of s.env) {
      if (e.source === "generated_from_service" || e.source === "generated_from_managed") {
        const hasEdge = plan.wiring.some(
          (w) => w.toServiceId === s.id && w.toEnvName === e.name,
        );
        if (!hasEdge) {
          add({
            code: "generated_env_no_wiring",
            severity: "warning",
            message: `Generated env "${e.name}" on "${s.id}" has no matching wiring edge; ShipFix may not be able to inject its value.`,
            path: `services.${s.id}.env.${e.name}`,
          });
        }
      }
    }
  }

  // ── User secrets / open questions block deploy until answered (YELLOW) ─────
  for (const s of plan.services) {
    for (const e of s.env) {
      if (e.source === "user_secret") {
        add({
          code: "user_secret_required",
          severity: "needs_input",
          message: `"${s.id}" needs a secret value for "${e.name}" before it can deploy. ShipFix never sends secrets to the model.`,
          path: `services.${s.id}.env.${e.name}`,
        });
      }
    }
  }
  for (const q of plan.questions) {
    if (q.kind === "secret") {
      add({
        code: "question_needs_secret",
        severity: "needs_input",
        message: `ShipFix needs an answer before deploying: ${q.prompt}`,
        path: `questions.${q.id}`,
      });
    }
  }

  // ── Migrations: ShipFix provisions DBs but does not run migrations yet ─────
  for (const m of plan.managed) {
    if (m.migration && m.migration !== "none") {
      add({
        code: "migration_required",
        severity: "needs_input",
        message: `"${m.id}" uses ${m.migration} migrations. ShipFix provisions the database but does not run migrations in this release — run them manually after the database is live, then rerun deploy.`,
        path: `managed.${m.id}`,
      });
    }
  }

  // ── Managed services ───────────────────────────────────────────────────────
  for (const m of plan.managed) {
    if (m.mode === "provision" && !m.provider) {
      add({ code: "managed_provider_missing", severity: "fatal", message: `Managed service "${m.id}" is set to provision but names no provider.`, path: `managed.${m.id}` });
    }
    if (!m.exposesEnv) {
      add({ code: "managed_exposes_env_empty", severity: "fatal", message: `Managed service "${m.id}" declares no exposed env var.`, path: `managed.${m.id}` });
    }
  }

  // ── deployOrder integrity ──────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const id of plan.deployOrder) {
    if (!allIds.has(id)) {
      add({ code: "deploy_order_unknown_id", severity: "fatal", message: `deployOrder lists "${id}", which is not a service or managed service.`, path: "deployOrder" });
    }
    if (seen.has(id)) {
      add({ code: "deploy_order_duplicate", severity: "warning", message: `deployOrder lists "${id}" more than once.`, path: "deployOrder" });
    }
    seen.add(id);
  }
  for (const id of allIds) {
    if (!seen.has(id)) {
      add({ code: "deploy_order_missing_id", severity: "fatal", message: `"${id}" is missing from deployOrder.`, path: "deployOrder" });
    }
  }

  // ── Wiring edges ───────────────────────────────────────────────────────────
  plan.wiring.forEach((edge, i) => {
    if (!allIds.has(edge.fromServiceId)) {
      add({ code: "wiring_unknown_from", severity: "fatal", message: `Wiring edge ${i} sources from "${edge.fromServiceId}", which does not exist.`, path: `wiring[${i}]` });
    }
    if (!serviceIds.has(edge.toServiceId)) {
      add({ code: "wiring_unknown_to", severity: "fatal", message: `Wiring edge ${i} targets "${edge.toServiceId}", which is not a service.`, path: `wiring[${i}]` });
    }
    if (!edge.toEnvName) {
      add({ code: "wiring_empty_env", severity: "fatal", message: `Wiring edge ${i} does not name a target env var.`, path: `wiring[${i}]` });
    }
    const fromIsManaged = managedIds.has(edge.fromServiceId);
    const fieldOk = edge.fromField === "connectionUrl" ? fromIsManaged : !fromIsManaged;
    if (allIds.has(edge.fromServiceId) && !fieldOk) {
      add({ code: "wiring_bad_field", severity: "fatal", message: `Wiring edge ${i} uses field "${edge.fromField}" with an incompatible source.`, path: `wiring[${i}]` });
    }
  });

  // ── Questions reference real services ──────────────────────────────────────
  for (const q of plan.questions) {
    for (const sid of q.blocksServiceIds) {
      if (!serviceIds.has(sid)) {
        add({ code: "question_unmapped_service", severity: "warning", message: `Question "${q.id}" blocks service "${sid}", which is not in the plan.`, path: `questions.${q.id}` });
      }
    }
  }

  // ── Provider / managed-provider availability (capabilities) ────────────────
  for (const svc of plan.services) {
    // Genuinely unsupported types are already flagged RED above; don't double-flag.
    if (!isServiceTypeSupported(svc.provider, svc.type)) continue;
    const types = caps.providers.get(svc.provider);
    if (!types) {
      // Supported by ShipFix, just not connected by this user -> YELLOW.
      add({ code: "provider_not_connected", severity: "needs_input", message: `Connect a ${svc.provider} account to deploy "${svc.id}".`, path: `services.${svc.id}` });
    } else if (!types.has(svc.type)) {
      add({ code: "provider_servicetype_unsupported", severity: "fatal", message: `Provider "${svc.provider}" cannot deploy service type "${svc.type}" (service "${svc.id}").`, path: `services.${svc.id}` });
    }
  }

  const provisionManaged = plan.managed.filter((m) => m.mode === "provision");
  for (const m of provisionManaged) {
    if (!m.provider) continue;
    // Unsupported managed kinds are already flagged RED above.
    if (!isManagedSupported(m.provider, m.kind)) continue;
    if (!caps.managedProviders.has(m.provider)) {
      // Supported, just not connected -> YELLOW.
      add({ code: "managed_not_connected", severity: "needs_input", message: `Connect a ${m.provider} account to provision "${m.id}".`, path: `managed.${m.id}` });
    }
  }

  // ── Verification path grounding (route evidence) ───────────────────────────
  checkVerificationGrounding(plan, ctx, add);

  // ── Compute downgraded classification + capped confidence ──────────────────
  const floor = issues.reduce((max, i) => Math.max(max, sevRank(i.severity)), 0);
  const finalRank = Math.max(RANK[plan.classification], floor);
  const classification = CLASSES[finalRank];

  const confidenceCap = floor === 2 ? 0.3 : floor === 1 ? 0.6 : 1;
  const confidence = capConfidenceForVerification(
    Math.min(plan.confidence, confidenceCap),
    issues,
  );

  const validatedPlan: DeploymentPlan = {
    ...plan,
    classification,
    confidence,
    // Preserve the planner's blockers; append validation findings.
    blockers: [...plan.blockers, ...issues.map(issueToBlocker)],
  };

  return { plan: validatedPlan, issues };
}
