import type {
  Blocker,
  DeploymentPlan,
  EnvVar,
  ManagedService,
  PlanQuestion,
  PlanService,
  RepoContext,
  ServiceSignal,
  VerificationCheck,
  WiringEdge,
} from "@shipfix/contracts";
import { normalizeRoutePath, topHealthCandidate } from "@shipfix/validator";

/**
 * Deterministic plan synthesis for the supported slice.
 *
 * When the analyzer's evidence fully describes a repo ShipFix can actually
 * deploy (Vite/CRA frontend on Vercel, Node API on Render, optional Neon
 * Postgres), the plan is BUILT IN CODE from that evidence — commands from the
 * scripts map, health path from grounded route candidates, env wiring from
 * detected refs. No model in the loop: the same repo always produces the same
 * plan, regardless of which LLM is configured or whether it is having a bad
 * day. Anything outside this slice returns null and goes to the LLM proposal
 * path (which the validator still gates).
 */

/** Frontend frameworks with a known static build output directory. */
const FRONTEND_OUTPUT_DIR: Record<string, string> = {
  vite: "dist",
  cra: "build",
};

const BACKEND_FRAMEWORKS = new Set(["express", "fastify", "koa", "hapi"]);

const DB_URL_RE = /^(DATABASE_URL|POSTGRES(QL)?_URL|PG_?(CONNECTION_)?(STRING|URL)|DB_URL)$/i;
const HEALTH_PATH_RE = /health|healthz|ready|readyz|status|live|ping/i;
const API_URL_RE = /^(VITE_|REACT_APP_|PUBLIC_)?\w*(API|BACKEND|SERVER)\w*_(URL|ORIGIN|BASE|BASE_URL|HOST|ENDPOINT)$/i;
const FRONTEND_ORIGIN_RE = /^\w*(CORS|FRONTEND|CLIENT|WEB|ALLOWED)\w*_(ORIGINS?|URLS?)$/i;

function pmCommand(signal: ServiceSignal, kind: "install" | "build" | "start"): string {
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(signal.packageManager)
    ? signal.packageManager
    : "npm";
  if (kind === "install") return `${pm} install`;
  return `${pm} run ${kind}`;
}

interface SliceShape {
  frontend: ServiceSignal | null;
  backend: ServiceSignal | null;
  /** A standalone Next.js app (deployed to Vercel as frontend_ssr). */
  next: ServiceSignal | null;
  wantsPostgres: boolean;
  migrationTool: ManagedService["migration"];
}

/**
 * Decide whether the repo fits the deterministic slice. Returns null when the
 * evidence is incomplete or out of slice — the LLM path handles those.
 */
function matchSupportedSlice(ctx: RepoContext): SliceShape | null {
  if (ctx.services.length === 0) return null;

  let frontend: ServiceSignal | null = null;
  let backend: ServiceSignal | null = null;
  let next: ServiceSignal | null = null;

  for (const s of ctx.services) {
    if (s.language === "node" && s.role === "frontend" && s.framework in FRONTEND_OUTPUT_DIR) {
      if (frontend) return null; // multiple frontends — ambiguous, LLM decides
      frontend = s;
    } else if (s.language === "node" && s.role === "backend" && BACKEND_FRAMEWORKS.has(s.framework)) {
      if (backend) return null;
      backend = s;
    } else if (s.language === "node" && s.role === "fullstack" && s.framework === "next") {
      if (next) return null;
      next = s;
    } else {
      return null; // python/docker/non-Next SSR/unknown — out of slice
    }
  }

  // A Next app alongside a separate frontend or backend is an architecture call
  // the deterministic path won't make — let the LLM propose, validator gate.
  if (next && (frontend || backend)) return null;

  // Commands must be grounded in declared scripts, or the plan can't be honest.
  if (frontend && !frontend.scripts.build) return null;
  if (backend && !backend.scripts.start) return null;
  if (next && !next.scripts.build) return null;

  let wantsPostgres = false;
  let migrationTool: ManagedService["migration"] = "none";
  for (const need of ctx.dataNeeds) {
    if (need.kind !== "postgres") return null; // redis/mysql/etc — out of slice
    wantsPostgres = true;
    if (need.migrationTool !== "none") migrationTool = need.migrationTool;
  }
  if (wantsPostgres && !backend && !next) return null; // DB with no server — ambiguous

  return { frontend, backend, next, wantsPostgres, migrationTool };
}

/** Build the DeploymentPlan for a slice-matching repo. Null = use the LLM. */
export function synthesizeDeterministicPlan(ctx: RepoContext): DeploymentPlan | null {
  const shape = matchSupportedSlice(ctx);
  if (!shape) return null;
  const { frontend, backend, next, wantsPostgres, migrationTool } = shape;

  const services: PlanService[] = [];
  const managed: ManagedService[] = [];
  const wiring: WiringEdge[] = [];
  const questions: PlanQuestion[] = [];
  const blockers: Blocker[] = [];
  const verification: VerificationCheck[] = [];
  const deployOrder: string[] = [];
  let needsSetup = false;

  const refsFor = (signal: ServiceSignal): string[] =>
    ctx.envRefs.filter((r) => r.service === signal.rootDir && r.required).map((r) => r.name);

  const askSecret = (name: string, serviceId: string, prompt: string): EnvVar => {
    needsSetup = true;
    questions.push({
      id: `secret-${serviceId}-${name}`,
      prompt,
      kind: "secret",
      blocksServiceIds: [serviceId],
    });
    return { name, source: "user_secret" };
  };

  // ── Managed Postgres (Neon) ────────────────────────────────────────────────
  const dbConsumer = backend ?? next;
  let dbEnvName = "DATABASE_URL";
  if (wantsPostgres && dbConsumer) {
    const dbRefs = refsFor(dbConsumer).filter((n) => DB_URL_RE.test(n));
    dbEnvName = dbRefs.find((n) => n.toUpperCase() === "DATABASE_URL") ?? dbRefs[0] ?? "DATABASE_URL";
    managed.push({
      id: "db",
      kind: "postgres",
      mode: "provision",
      provider: "neon",
      exposesEnv: dbEnvName,
      migration: migrationTool,
    });
    deployOrder.push("db");
    verification.push({ serviceId: "db", check: "db_connect" });
    if (migrationTool !== "none") needsSetup = true; // validator flags migration_required
  }

  // ── Backend (Render node_api) ──────────────────────────────────────────────
  if (backend) {
    const env: EnvVar[] = [];
    for (const name of refsFor(backend)) {
      if (name === "PORT") {
        env.push({ name, source: "provider_injected" });
      } else if (wantsPostgres && DB_URL_RE.test(name)) {
        env.push({ name, source: "generated_from_managed", ref: "db.connectionUrl" });
        wiring.push({ fromServiceId: "db", fromField: "connectionUrl", toServiceId: "api", toEnvName: name });
      } else if (FRONTEND_ORIGIN_RE.test(name) && frontend) {
        // The backend deploys BEFORE the frontend, so its public origin cannot
        // be wired automatically in this one-pass engine. Ask for it honestly
        // instead of guessing or deploying a backend that rejects its own UI.
        env.push(
          askSecret(
            name,
            "api",
            `The backend reads "${name}" (likely the allowed frontend origin for CORS). ShipFix deploys the backend before the frontend, so supply the frontend URL after the first deploy, or set a safe default in the repo.`,
          ),
        );
      } else {
        env.push(
          askSecret(
            name,
            "api",
            `The backend requires the environment variable "${name}". ShipFix cannot derive its value from the repo; provide it before deploying.`,
          ),
        );
      }
    }

    const top = topHealthCandidate(backend.routeCandidates);
    const healthCheckPath = top ? normalizeRoutePath(top.path) : null;
    const healthCandidates = backend.routeCandidates
      .filter((c) => c.method === "GET" || c.method === "HEAD" || c.method === "ALL")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((c) => normalizeRoutePath(c.path));
    if (!healthCheckPath) needsSetup = true; // validator: backend_health_ungrounded

    services.push({
      id: "api",
      type: "node_api",
      provider: "render",
      rootDir: backend.rootDir,
      install: pmCommand(backend, "install"),
      build: backend.scripts.build ? pmCommand(backend, "build") : null,
      start: pmCommand(backend, "start"),
      outputDir: null,
      healthCheckPath,
      healthCandidates: [...new Set(healthCandidates)],
      env,
      evidence: backend.evidence,
    });
    deployOrder.push("api");
    if (healthCheckPath) {
      verification.push({ serviceId: "api", check: "health_path", target: healthCheckPath });
    }
  }

  // ── Standalone Next.js app (Vercel frontend_ssr) ───────────────────────────
  if (next) {
    const env: EnvVar[] = [];
    for (const name of refsFor(next)) {
      if (name === "PORT") {
        env.push({ name, source: "provider_injected" });
      } else if (wantsPostgres && DB_URL_RE.test(name)) {
        env.push({ name, source: "generated_from_managed", ref: "db.connectionUrl" });
        wiring.push({ fromServiceId: "db", fromField: "connectionUrl", toServiceId: "web", toEnvName: name });
      } else {
        env.push(
          askSecret(
            name,
            "web",
            `The app requires the environment variable "${name}". ShipFix cannot derive its value from the repo; provide it before deploying.`,
          ),
        );
      }
    }

    // API-route health is OPTIONAL for Next: the primary proof of life is
    // frontend_loads. Only pin a health path when a dedicated health-style API
    // route exists — probing an arbitrary data route could fail a healthy app.
    const getCandidates = next.routeCandidates
      .filter((c) => c.method === "GET" || c.method === "HEAD" || c.method === "ALL")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const healthCandidates = [...new Set(getCandidates.map((c) => normalizeRoutePath(c.path)))];
    const top = topHealthCandidate(next.routeCandidates);
    const healthCheckPath =
      top && HEALTH_PATH_RE.test(top.path) ? normalizeRoutePath(top.path) : null;

    services.push({
      id: "web",
      type: "frontend_ssr",
      provider: "vercel",
      rootDir: next.rootDir,
      install: pmCommand(next, "install"),
      build: pmCommand(next, "build"),
      start: null,
      outputDir: null,
      healthCheckPath,
      healthCandidates,
      env,
      evidence: next.evidence,
    });
    deployOrder.push("web");
    verification.push({ serviceId: "web", check: "frontend_loads" });
    if (healthCheckPath) {
      verification.push({ serviceId: "web", check: "health_path", target: healthCheckPath });
    }

    const hardcoded = ctx.hardcodedUrls.filter((u) => u.service === next.rootDir);
    if (hardcoded.length > 0) {
      needsSetup = true;
      blockers.push({
        severity: "needs_input",
        title: "App hardcodes a local URL",
        explanation: `The app contains hardcoded local URL(s) (${hardcoded
          .map((u) => u.value)
          .slice(0, 3)
          .join(", ")}). After deployment it would still call localhost.`,
        action: "Replace the hardcoded URL with an environment variable and rerun the plan.",
        autoFixable: false,
        evidence: hardcoded.map((u) => u.file),
      });
    }
  }

  // ── Frontend (Vercel frontend_static) ──────────────────────────────────────
  if (frontend) {
    const env: EnvVar[] = [];
    for (const name of refsFor(frontend)) {
      if (API_URL_RE.test(name) && backend) {
        env.push({ name, source: "generated_from_service", ref: "api.publicUrl" });
        wiring.push({ fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: name });
      } else {
        env.push(
          askSecret(
            name,
            "web",
            `The frontend build requires the environment variable "${name}". Provide its value before deploying.`,
          ),
        );
      }
    }

    services.push({
      id: "web",
      type: "frontend_static",
      provider: "vercel",
      rootDir: frontend.rootDir,
      install: pmCommand(frontend, "install"),
      build: pmCommand(frontend, "build"),
      start: null,
      outputDir: FRONTEND_OUTPUT_DIR[frontend.framework] ?? "dist",
      healthCheckPath: null,
      healthCandidates: [],
      env,
      evidence: frontend.evidence,
    });
    deployOrder.push("web");
    verification.push({ serviceId: "web", check: "frontend_loads" });

    if (backend && services.some((s) => s.id === "api" && s.healthCheckPath)) {
      verification.push({ serviceId: "api", check: "cors_from", target: "web" });
    }

    // A hardcoded localhost URL in the frontend will break in production even
    // if every deploy step succeeds — surface it before deploying.
    const hardcoded = ctx.hardcodedUrls.filter((u) => u.service === frontend.rootDir);
    if (hardcoded.length > 0) {
      needsSetup = true;
      blockers.push({
        severity: "needs_input",
        title: "Frontend hardcodes a local URL",
        explanation: `The frontend contains hardcoded local URL(s) (${hardcoded
          .map((u) => u.value)
          .slice(0, 3)
          .join(", ")}). After deployment it would still call localhost, so the live app would not reach the backend.`,
        action:
          "Replace the hardcoded URL with an environment variable (for example VITE_API_URL) and rerun the plan.",
        autoFixable: false,
        evidence: hardcoded.map((u) => u.file),
      });
    }
  }

  const parts = [
    next ? "Next.js app on Vercel" : null,
    frontend ? `${frontend.framework} frontend on Vercel` : null,
    backend ? `${backend.framework} API on Render` : null,
    wantsPostgres ? "Neon Postgres" : null,
  ].filter(Boolean);

  return {
    goal: `Deploy ${ctx.repoFullName}: ${parts.join(" + ")}.`,
    classification: needsSetup ? "needs_setup" : "deployable",
    services,
    managed,
    wiring,
    deployOrder,
    questions,
    blockers,
    verification,
    confidence: needsSetup ? 0.7 : 0.95,
    planSource: "deterministic",
  };
}
