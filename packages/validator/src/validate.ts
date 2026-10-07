import type {
  DeploymentPlan,
  EnvVar,
  PlanClassification,
  PlanService,
  RepoContext,
  WiringEdge,
} from "@shipfix/contracts";
import type { ManagedKind } from "@shipfix/contracts";
import { IntegrationField, isVercelSsrFramework, isWebBackendType, MANAGED_ENV_FIELDS, SECRET_INTEGRATION_FIELDS } from "@shipfix/contracts";
import { redact } from "@shipfix/secrets";
import type { Capabilities } from "./capabilities";
import { issueToBlocker, isValidationBlockerTitle, type ValidationIssue } from "./issues";
import { isManagedSupported, isServiceTypeSupported, MVP_SUPPORT_SUMMARY } from "./mvpSupport";
import {
  capConfidenceForVerification,
  checkVerificationGrounding,
  normalizeRoutePath,
  routeCandidatesForService,
} from "./verificationGrounding";

type InferredRun = RepoContext["services"][number]["inferredRun"];

/** Start commands grounded in the repo: the inferred start, optionally preceded by its release step. */
function groundedPythonStarts(run: InferredRun): string[] {
  if (!run) return [];
  return run.release ? [run.start, `${run.release} && ${run.start}`] : [run.start];
}

export interface ValidationResult {
  /** The plan with classification downgraded + validation blockers appended. */
  plan: DeploymentPlan;
  /** Every deterministic finding (for run events / debugging). */
  issues: ValidationIssue[];
}

/** Optional context for revalidation after HITL answers (C2). */
export interface ValidatePlanOptions {
  /**
   * PlanQuestion ids that already have answers (e.g. `secret-api-STRIPE_KEY`).
   * When set, matching user_secret / secret-question issues are skipped and
   * classification is recomputed from remaining issues only.
   */
  satisfiedSecretQuestionIds?: ReadonlySet<string>;
  /** Env var names satisfied via durable project env (B2). */
  satisfiedEnvNames?: ReadonlySet<string>;
}

const SSR_SUPPORT_TEXT = "Next.js, Nuxt, Remix, React Router, SvelteKit and TanStack Start";

const SSR_UNSUPPORTED_HINT: Record<string, string> = {
  "tanstack-start-node":
    " TanStack Start needs the Nitro Vite plugin (the `nitro` package) to build for Vercel.",
  "sveltekit-node":
    " SvelteKit needs @sveltejs/adapter-auto or @sveltejs/adapter-vercel to build for Vercel.",
  "remix-cloudflare": " This Remix app is built for Cloudflare Pages, which ShipFix doesn't deploy to yet.",
};

function secretQuestionId(serviceId: string, envName: string): string {
  return `secret-${serviceId}-${envName}`;
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

const BROWSER_ENV_PREFIX_RE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

function hasScript(ctx: RepoContext, rootDir: string, script: string): boolean {
  return Boolean(ctx.services.find((s) => s.rootDir === rootDir)?.scripts?.[script]);
}

function checkEnvVar(
  service: PlanService,
  env: EnvVar,
  serviceIds: Set<string>,
  managedKinds: ReadonlyMap<string, ManagedKind>,
  publicValues: Set<string>,
  add: (i: ValidationIssue) => void,
): void {
  const path = `services.${service.id}.env.${env.name}`;
  if (env.source === "generated_secret" && BROWSER_ENV_PREFIX_RE.test(env.name)) {
    add({ code: "env_generated_secret_public", severity: "fatal", message: `"${env.name}" on "${service.id}" is compiled into the browser bundle, so ShipFix will not put a generated secret in it.`, path });
    return;
  }
  if (env.source === "literal") {
    if (env.value == null || env.value === "") {
      add({ code: "env_literal_missing_value", severity: "fatal", message: `Literal env "${env.name}" on "${service.id}" has no value.`, path });
    } else if (!publicValues.has(env.value) && redact(env.value) !== env.value) {
      add({ code: "env_literal_secret_shaped", severity: "fatal", message: `Literal env "${env.name}" on "${service.id}" looks like a secret value and must not be embedded in the plan.`, path });
    }
    return;
  }
  if (env.source === "generated_from_service" || env.source === "generated_from_managed") {
    const ref = env.ref ?? "";
    const [refId, field] = ref.split(".");
    const managedKind = refId ? managedKinds.get(refId) : undefined;
    const valid =
      env.source === "generated_from_service"
        ? !!refId && serviceIds.has(refId) && (field === "publicUrl" || field === "origin")
        : managedKind !== undefined && MANAGED_ENV_FIELDS[managedKind].includes(field ?? "");
    if (!valid) {
      add({
        code: "env_ref_unresolved",
        severity: "fatal",
        message: `Generated env "${env.name}" on "${service.id}" references "${ref || "(empty)"}", which does not resolve to a valid ${env.source === "generated_from_service" ? "service.publicUrl/origin" : "managed-service field"}.`,
        path,
      });
      return;
    }
    if (env.source === "generated_from_managed" && (service.type === "frontend_static" || BROWSER_ENV_PREFIX_RE.test(env.name))) {
      add({ code: "env_managed_secret_public", severity: "fatal", message: `"${env.name}" on "${service.id}" would put a ${managedKind} credential into the browser bundle.`, path });
    }
  }
}

/** Question id a plan uses to ask which existing project an integration points at. */
export function integrationProjectQuestionId(integrationId: string): string {
  return `integration-${integrationId}-project`;
}

/**
 * Integration env must point at a declared integration and a known field,
 * secret fields never go to browser-compiled names, and the user must have
 * connected the provider (or set every such env on the project themselves).
 */
function checkIntegrations(
  plan: DeploymentPlan,
  caps: Capabilities,
  satisfiedQs: ReadonlySet<string>,
  satisfiedEnvs: ReadonlySet<string>,
  add: (i: ValidationIssue) => void,
): void {
  const integrations = new Map((plan.integrations ?? []).map((i) => [i.id, i]));
  const envByIntegration = new Map<string, string[]>();
  for (const s of plan.services) {
    for (const e of s.env) {
      if (e.source !== "integration") continue;
      const path = `services.${s.id}.env.${e.name}`;
      const [id, field] = (e.ref ?? "").split(".");
      const parsedField = IntegrationField.safeParse(field);
      if (!id || !integrations.has(id) || !parsedField.success) {
        add({ code: "env_ref_unresolved", severity: "fatal", message: `"${e.name}" on "${s.id}" references "${e.ref ?? "(empty)"}", which is not a declared integration value.`, path });
        continue;
      }
      if (SECRET_INTEGRATION_FIELDS.has(parsedField.data) && (s.type === "frontend_static" || BROWSER_ENV_PREFIX_RE.test(e.name))) {
        add({ code: "env_integration_secret_public", severity: "fatal", message: `"${e.name}" on "${s.id}" would put the ${parsedField.data} into the browser bundle.`, path });
        continue;
      }
      envByIntegration.set(id, [...(envByIntegration.get(id) ?? []), e.name]);
    }
  }
  for (const [id, names] of envByIntegration) {
    const integration = integrations.get(id)!;
    const allSetByUser = names.every((n) => satisfiedEnvs.has(n));
    if (!caps.integrations.has(integration.provider) && !allSetByUser) {
      add({
        code: "integration_not_connected",
        severity: "needs_input",
        message: `Connect your ${integration.provider} account so ShipFix can fill ${[...new Set(names)].join(", ")} from your existing project.`,
        path: `integrations.${id}`,
      });
    }
    if (!integration.projectRef && !allSetByUser && !satisfiedQs.has(integrationProjectQuestionId(id))) {
      add({
        code: "integration_project_unknown",
        severity: "needs_input",
        message: `ShipFix couldn't tell which ${integration.provider} project this app uses. Answer the setup question with the project ref.`,
        path: `integrations.${id}`,
      });
    }
  }
}

function generatedEnvWiringEdge(service: PlanService, env: EnvVar): WiringEdge | null {
  if (env.source !== "generated_from_service" && env.source !== "generated_from_managed") return null;
  const [refId, field] = (env.ref ?? "").split(".");
  if (!refId || !field) return null;
  if (env.source === "generated_from_service" && field !== "publicUrl" && field !== "origin") return null;
  if (env.source === "generated_from_managed" && field !== "connectionUrl" && field !== "restUrl" && field !== "restToken") {
    return null;
  }
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
  planInput: DeploymentPlan,
  ctx: RepoContext,
  caps: Capabilities,
  opts: ValidatePlanOptions = {},
): ValidationResult {
  const recompute =
    opts.satisfiedSecretQuestionIds != null || opts.satisfiedEnvNames != null;
  const plan: DeploymentPlan = recompute
    ? {
        ...planInput,
        classification: "deployable",
        blockers: planInput.blockers.filter((b) => !isValidationBlockerTitle(b.title)),
      }
    : planInput;

  const issues: ValidationIssue[] = [];
  const add = (i: ValidationIssue): void => void issues.push(i);
  const satisfiedQs = opts.satisfiedSecretQuestionIds ?? new Set<string>();
  const satisfiedEnvs = opts.satisfiedEnvNames ?? new Set<string>();

  const serviceIds = new Set(plan.services.map((s) => s.id));
  const managedIds = new Set(plan.managed.map((m) => m.id));
  const managedKinds = new Map(plan.managed.map((m) => [m.id, m.kind]));
  const allIds = new Set([...serviceIds, ...managedIds]);
  const scriptsByRoot = new Map(ctx.services.map((s) => [s.rootDir, s.scripts]));
  const publicValues = new Set((ctx.publicEnv ?? []).map((v) => v.value));

  // ── Services exist + commands grounded + env refs valid ───────────────────
  for (const svc of plan.services) {
    if (!rootExists(svc.rootDir, ctx)) {
      add({ code: "service_root_unknown", severity: "fatal", message: `Service "${svc.id}" points to rootDir "${svc.rootDir}", which is not present in the repository.`, path: `services.${svc.id}` });
    }
    checkCommand(svc, svc.install, "install", scriptsByRoot, add);
    checkCommand(svc, svc.build, "build", scriptsByRoot, add);
    checkCommand(svc, svc.start, "start", scriptsByRoot, add);
    if (
      (svc.type === "frontend_static" || svc.type === "frontend_ssr") &&
      !svc.build &&
      !hasScript(ctx, svc.rootDir, "build")
    ) {
      add({
        code: "frontend_build_missing",
        severity: "fatal",
        message: `Frontend "${svc.id}" has no grounded build script. ShipFix needs a reproducible build before it can deploy to Vercel.`,
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
    const signal = ctx.services.find((s) => s.rootDir === svc.rootDir);
    if (svc.type === "python_api") {
      if (!svc.start || !svc.install) {
        add({
          code: "backend_start_missing",
          severity: "fatal",
          message: `Python service "${svc.id}" needs install and start commands before ShipFix can deploy it to Render.`,
          path: `services.${svc.id}.start`,
        });
      } else if (!groundedPythonStarts(signal?.inferredRun).includes(svc.start)) {
        add({
          code: "python_start_ungrounded",
          severity: "needs_input",
          message: `Python service "${svc.id}" start command "${svc.start}" was not found in the repo (no Procfile or detected app entry point runs it). Confirm how the app starts before deploying.`,
          path: `services.${svc.id}.start`,
        });
      }
    }
    if (svc.type === "worker") {
      const grounded = (signal?.workers ?? []).some(
        (w) => (w.command && w.command === svc.start) || (w.script && svc.start?.endsWith(` run ${w.script}`)),
      );
      if (!grounded) {
        add({
          code: "worker_start_ungrounded",
          severity: "needs_input",
          message: `Worker "${svc.id}" start command "${svc.start ?? ""}" does not match a worker process in the repo (a Procfile worker line or a package.json worker script). Confirm how the worker starts before deploying.`,
          path: `services.${svc.id}.start`,
        });
      }
    }
    if (svc.type === "docker_service" && !signal?.hasDockerfile) {
      add({
        code: "docker_file_missing",
        severity: "fatal",
        message: `Service "${svc.id}" is planned as a Docker service, but "${svc.rootDir || "/"}" has no Dockerfile.`,
        path: `services.${svc.id}`,
      });
    }
    for (const env of svc.env) checkEnvVar(svc, env, serviceIds, managedKinds, publicValues, add);
  }

  const deployedAs = (rootDir: string, types: readonly string[]): boolean =>
    plan.services.some((s) => s.rootDir === rootDir && types.includes(s.type));
  for (const signal of ctx.services) {
    if (signal.language === "python") {
      if (deployedAs(signal.rootDir, ["python_api", "docker_service"])) continue;
      add({
        code: "repo_python_unsupported",
        severity: "fatal",
        message:
          signal.framework === "python"
            ? `Detected a Python project at "${signal.rootDir || "/"}" without a recognizable web framework (FastAPI, Flask, Django, Streamlit, Gradio, Chainlit) or a Dockerfile. ShipFix can't tell how to serve it.`
            : `Detected a Python/${signal.framework} service at "${signal.rootDir || "/"}", but ShipFix couldn't find how it starts. Add a Procfile ("web: <start command>") or a Dockerfile.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.language === "docker" || signal.framework === "docker-compose") {
      if (signal.framework === "docker" && deployedAs(signal.rootDir, ["docker_service"])) continue;
      add({
        code: "repo_docker_unsupported",
        severity: "fatal",
        message:
          signal.framework === "docker-compose"
            ? `Detected a docker-compose app at "${signal.rootDir || "/"}". ShipFix deploys single Dockerfile services, not multi-container compose stacks.`
            : signal.role === "backend"
              ? `Detected a Dockerfile service at "${signal.rootDir || "/"}" that this plan does not deploy.`
              : `Detected a Dockerfile at "${signal.rootDir || "/"}" with no EXPOSE line, so ShipFix can't tell whether it serves HTTP. Add "EXPOSE <port>" to the Dockerfile.`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.role === "fullstack" && !isVercelSsrFramework(signal.framework)) {
      add({
        code: "repo_ssr_unsupported",
        severity: "fatal",
        message: `Detected ${signal.framework} / SSR-style app at "${signal.rootDir || "/"}". ShipFix auto-deploys ${SSR_SUPPORT_TEXT} on Vercel, but not this setup.${SSR_UNSUPPORTED_HINT[signal.framework] ?? ""}`,
        path: `repo.services.${signal.rootDir || "/"}`,
      });
    } else if (signal.role === "unknown") {
      add({
        code: "repo_unknown_framework",
        severity: "fatal",
        message: `ShipFix could not identify a supported app framework at "${signal.rootDir || "/"}". Supported path is a Vite/static or Next.js frontend plus an Express/Fastify/Node API.`,
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
      if (e.source !== "user_secret") continue;
      const qid = secretQuestionId(s.id, e.name);
      if (satisfiedQs.has(qid) || satisfiedEnvs.has(e.name)) continue;
      add({
        code: "user_secret_required",
        severity: "needs_input",
        message: `"${s.id}" needs a secret value for "${e.name}" before it can deploy. ShipFix never sends secrets to the model.`,
        path: `services.${s.id}.env.${e.name}`,
      });
    }
  }
  for (const q of plan.questions) {
    if (q.kind !== "secret") continue;
    if (satisfiedQs.has(q.id)) continue;
    // Also treat as satisfied when the env name suffix matches a project env.
    const envSuffix = q.id.includes("-") ? q.id.slice(q.id.lastIndexOf("-") + 1) : "";
    if (envSuffix && satisfiedEnvs.has(envSuffix)) continue;
    add({
      code: "question_needs_secret",
      severity: "needs_input",
      message: `ShipFix needs an answer before deploying: ${q.prompt}`,
      path: `questions.${q.id}`,
    });
  }

  // ── Migrations: Prisma/Drizzle are executed by ShipFix; Django/Alembic run
  // as a Python service's grounded release step; other tools still need setup ─
  const releaseRuns = plan.services.flatMap((svc) => {
    const signal = ctx.services.find((s) => s.rootDir === svc.rootDir);
    if (svc.type === "docker_service" && signal?.imageMigrates) {
      return [signal.imageMigrates === "django" ? "manage.py migrate" : "alembic upgrade"];
    }
    if (svc.type !== "python_api" || !svc.start) return [];
    const release = signal?.inferredRun?.release;
    return release && svc.start.startsWith(`${release} && `) ? [release] : [];
  });
  for (const m of plan.managed) {
    if (
      !m.migration ||
      m.migration === "none" ||
      m.migration === "prisma" ||
      m.migration === "drizzle"
    ) {
      continue;
    }
    const tool = m.migration === "django" ? /manage\.py migrate/ : /alembic upgrade/;
    if ((m.migration === "django" || m.migration === "alembic") && releaseRuns.some((r) => tool.test(r))) continue;
    add({
      code: "migration_required",
      severity: "needs_input",
      message: `"${m.id}" uses ${m.migration} migrations, and no service runs them before starting. ShipFix provisions the database but cannot apply these migrations — run them manually after the database is live, then rerun deploy.`,
      path: `managed.${m.id}`,
    });
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
    const fromKind = managedKinds.get(edge.fromServiceId);
    const fieldOk = fromKind
      ? MANAGED_ENV_FIELDS[fromKind].includes(edge.fromField)
      : edge.fromField === "publicUrl" || edge.fromField === "origin";
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

  checkIntegrations(plan, caps, satisfiedQs, satisfiedEnvs, add);

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

  // Persist every grounded GET route as a health fallback candidate so the
  // verifier can probe alternatives instead of failing hard on a single 404.
  // Candidates come only from analyzer evidence — never invented.
  const servicesWithCandidates = plan.services.map((svc) => {
    if (!isWebBackendType(svc.type) && svc.type !== "frontend_ssr") {
      return svc;
    }
    // Plans built outside Zod parsing may omit the defaulted array.
    if ((svc.healthCandidates ?? []).length > 0) return svc;
    const grounded = routeCandidatesForService(ctx, svc.rootDir)
      .filter((c) => c.method === "GET" || c.method === "HEAD" || c.method === "ALL")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((c) => normalizeRoutePath(c.path));
    return { ...svc, healthCandidates: [...new Set(grounded)] };
  });

  const validatedPlan: DeploymentPlan = {
    ...plan,
    services: servicesWithCandidates,
    classification,
    confidence,
    // Preserve the planner's blockers; append validation findings.
    blockers: [...plan.blockers, ...issues.map(issueToBlocker)],
  };

  return { plan: validatedPlan, issues };
}
