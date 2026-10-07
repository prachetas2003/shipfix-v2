import type {
  Blocker,
  DeploymentPlan,
  EnvVar,
  ManagedService,
  PlanIntegration,
  PlanQuestion,
  PlanService,
  RepoContext,
  ServiceSignal,
  VerificationCheck,
  WiringEdge,
} from "@shipfix/contracts";
import { isVercelSsrFramework } from "@shipfix/contracts";
import { normalizeRoutePath, topHealthCandidate } from "@shipfix/validator";
import { SUPABASE_INTEGRATION_ID, supabaseFieldFor, supabaseProjectQuestion } from "./supabaseEnv";

/**
 * Deterministic plan synthesis for the supported slice.
 *
 * When the analyzer's evidence fully describes a repo ShipFix can actually
 * deploy (Vite/CRA or a server-rendered app such as Next.js on Vercel, Node API on Render, optional Neon
 * Postgres — including Next App Router + separate API monorepos), the plan is
 * BUILT IN CODE from that evidence — commands from the scripts map, health
 * path from grounded route candidates, env wiring from detected refs. No model
 * in the loop: the same repo always produces the same plan, regardless of
 * which LLM is configured or whether it is having a bad day. Anything outside
 * this slice returns null and goes to the LLM proposal path (which the
 * validator still gates).
 */

/** Frontend frameworks with a known static build output directory. */
const FRONTEND_OUTPUT_DIR: Record<string, string> = {
  vite: "dist",
  cra: "build",
  "sveltekit-static": "build",
};

const SSR_LABEL: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  remix: "Remix",
  "react-router": "React Router",
  sveltekit: "SvelteKit",
  "tanstack-start": "TanStack Start",
};

const BACKEND_FRAMEWORKS = new Set(["express", "fastify", "koa", "hapi", "hono", "h3", "restify", "polka", "node-http"]);

/**
 * Build-time values a static frontend's bundler config demands but that have
 * one correct answer on a static host (Replit's Vite template throws without
 * PORT and BASE_PATH). Non-secret by construction.
 */
const STATIC_BUILD_DEFAULTS: Record<string, string> = {
  PORT: "3000",
  BASE_PATH: "/",
};

const CLIENT_PREFIX_RE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

/**
 * Server env names that may be satisfied by a differently named public key.
 * Server-side SUPABASE_KEY is deliberately absent: it is often the service-role key.
 */
const PUBLIC_ALIASES: Record<string, string[]> = {
  SUPABASE_ANON_KEY: ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_KEY"],
  SUPABASE_PUBLISHABLE_KEY: ["SUPABASE_ANON_KEY", "SUPABASE_KEY"],
};

/**
 * App-owned signing secrets whose only requirement is "long and random".
 * ShipFix generates them once per project and keeps them sealed. Never
 * provider-issued keys (STRIPE_WEBHOOK_SECRET, CLERK_SECRET_KEY...) — those
 * must come from the provider.
 */
const GENERATED_SECRET_NAMES = new Set([
  "CRON_SECRET",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "BETTER_AUTH_SECRET",
  "JWT_SECRET",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "ACCESS_TOKEN_SECRET",
  "REFRESH_TOKEN_SECRET",
  "TOKEN_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "APP_SECRET",
  "SECRET_KEY_BASE",
]);

const DB_URL_RE = /^(DATABASE_URL|POSTGRES(QL)?_URL|PG_?(CONNECTION_)?(STRING|URL)|DB_URL)$/i;
const HEALTH_PATH_RE = /health|healthz|ready|readyz|status|live|ping/i;
const API_URL_RE = /^(VITE_|REACT_APP_|PUBLIC_)?\w*(API|BACKEND|SERVER)\w*_(URL|ORIGIN|BASE|BASE_URL|HOST|ENDPOINT)$/i;
const STORAGE_ENV_RE = /^(AWS_|S3_|R2_|MINIO_)|_(S3|R2|BUCKET)(_|$)|BUCKET|STORAGE_(ENDPOINT|KEY|SECRET|REGION)/;
const FRONTEND_ORIGIN_RE = /^\w*(CORS|FRONTEND|CLIENT|WEB|ALLOWED)\w*_(ORIGINS?|URLS?)$/i;

function pmCommand(signal: ServiceSignal, kind: "install" | "build" | "start"): string {
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(signal.packageManager)
    ? signal.packageManager
    : "npm";
  if (kind === "install") return `${pm} install`;
  return `${pm} run ${kind}`;
}

/**
 * How a backend signal gets built on Render: from its scripts (Node), from the
 * analyzer's inferred run command (Python), or from its own Dockerfile. Python
 * without a run command and Docker without a declared port stay out of slice.
 */
function backendRuntime(s: ServiceSignal): "node_api" | "python_api" | "docker_service" | null {
  if (s.language === "node") return "node_api";
  if (s.language === "python" && s.role === "backend") {
    if (s.inferredRun) return "python_api";
    return s.hasDockerfile ? "docker_service" : null;
  }
  if (s.language === "docker" && s.framework === "docker" && s.role === "backend") return "docker_service";
  return null;
}

const RUNTIME_LABEL: Record<string, string> = {
  streamlit: "Streamlit app",
  gradio: "Gradio app",
  chainlit: "Chainlit app",
  docker: "Docker service",
};

interface SliceShape {
  frontend: ServiceSignal | null;
  backend: ServiceSignal | null;
  /** A server-rendered app — Next.js, TanStack Start, Nuxt, ... (Vercel frontend_ssr). */
  next: ServiceSignal | null;
  wantsPostgres: boolean;
  wantsRedis: boolean;
  /** S3-compatible storage the user brings (ShipFix does not create buckets). */
  usesObjectStorage: boolean;
  migrationTool: ManagedService["migration"];
}

const REDIS_REST_URL_RE = /^(UPSTASH_REDIS_REST_URL|KV_REST_API_URL)$/;
const REDIS_REST_TOKEN_RE = /^(UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN)$/;
const REDIS_URL_RE = /^(\w+_)?(REDIS_(URL|URI|TLS_URL|CONNECTION_STRING)|KV_URL)$/;

/** Which field of a provisioned Upstash database a server env name wants, if any. */
function redisFieldFor(name: string): "connectionUrl" | "restUrl" | "restToken" | null {
  if (CLIENT_PREFIX_RE.test(name)) return null;
  if (REDIS_REST_URL_RE.test(name)) return "restUrl";
  if (REDIS_REST_TOKEN_RE.test(name)) return "restToken";
  if (REDIS_URL_RE.test(name)) return "connectionUrl";
  return null;
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
    } else if (
      (s.language === "node" && s.role === "backend" && BACKEND_FRAMEWORKS.has(s.framework)) ||
      (s.language !== "node" && backendRuntime(s) !== null)
    ) {
      if (backend) return null;
      backend = s;
    } else if (s.language === "node" && s.role === "fullstack" && isVercelSsrFramework(s.framework)) {
      if (next) return null;
      next = s;
    } else {
      return null; // python/docker/unsupported SSR/unknown — out of slice
    }
  }

  // Next + a separate static frontend is ambiguous (which is the real UI?).
  // Next + one Node backend is the primary supported topology and is allowed.
  if (next && frontend) return null;

  // Commands must be grounded in declared scripts, or the plan can't be honest.
  if (frontend && !frontend.scripts.build) return null;
  if (backend && backendRuntime(backend) === "node_api" && !backend.scripts.start) return null;
  if (next && !next.scripts.build) return null;

  let wantsPostgres = false;
  let wantsRedis = false;
  let usesObjectStorage = false;
  let migrationTool: ManagedService["migration"] = "none";
  for (const need of ctx.dataNeeds) {
    if (need.hostedBy) continue; // already exists; the app reaches it through its own client
    if (need.kind === "redis") {
      wantsRedis = true;
      continue;
    }
    if (need.kind === "object_storage") {
      usesObjectStorage = true;
      continue;
    }
    if (need.kind !== "postgres") return null; // mysql/object storage/etc — out of slice
    wantsPostgres = true;
    if (need.migrationTool !== "none") migrationTool = need.migrationTool;
  }
  if ((wantsPostgres || wantsRedis || usesObjectStorage) && !backend && !next) return null; // store with no server — ambiguous
  if (wantsRedis) {
    // A client with no env to point it elsewhere (e.g. `new Redis()`) dials localhost; a new database wouldn't help.
    const servers = [backend?.rootDir, next?.rootDir];
    const wired = ctx.envRefs.some((r) => servers.includes(r.service) && redisFieldFor(r.name));
    if (!wired) return null;
  }

  return { frontend, backend, next, wantsPostgres, wantsRedis, usesObjectStorage, migrationTool };
}

/** Build the DeploymentPlan for a slice-matching repo. Null = use the LLM. */
export function synthesizeDeterministicPlan(ctx: RepoContext): DeploymentPlan | null {
  const shape = matchSupportedSlice(ctx);
  if (!shape) return null;
  const { frontend, backend, next, wantsPostgres, wantsRedis, usesObjectStorage, migrationTool } = shape;

  const services: PlanService[] = [];
  const managed: ManagedService[] = [];
  const wiring: WiringEdge[] = [];
  const questions: PlanQuestion[] = [];
  const blockers: Blocker[] = [];
  const verification: VerificationCheck[] = [];
  const deployOrder: string[] = [];
  const supabaseUsers = new Set<string>();
  let needsSetup = false;

  // Every referenced name is a wiring candidate (a fallback like
  // `VITE_API_URL || "http://localhost:3000"` still breaks in production), but
  // only refs without a code default ever become a question for the user.
  const refsFor = (signal: ServiceSignal): string[] =>
    ctx.envRefs.filter((r) => r.service === signal.rootDir).map((r) => r.name);
  const isRequired = (signal: ServiceSignal, name: string): boolean =>
    ctx.envRefs.some((r) => r.service === signal.rootDir && r.name === name && r.required);

  const publicEnv = ctx.publicEnv ?? [];
  const publicValueFor = (signal: ServiceSignal, name: string): string | null => {
    const exact =
      publicEnv.find((v) => v.service === signal.rootDir && v.name === name) ??
      publicEnv.find((v) => v.name === name);
    if (exact) return exact.value;
    if (CLIENT_PREFIX_RE.test(name)) return null;
    // Server code reading SUPABASE_URL can use the committed VITE_SUPABASE_URL.
    const aliases = [name, ...(PUBLIC_ALIASES[name] ?? [])];
    const alias = publicEnv.find((v) => aliases.includes(v.name.replace(CLIENT_PREFIX_RE, "")));
    return alias?.value ?? null;
  };

  /** Env the repo didn't wire: public value, generated secret, build default, or a question. */
  const unwiredEnv = (
    signal: ServiceSignal,
    serviceId: string,
    name: string,
    prompt: string,
    runsInBrowser: boolean,
  ): EnvVar | null => {
    const publicValue = publicValueFor(signal, name);
    if (publicValue != null) return { name, source: "literal", value: publicValue };
    if (!runsInBrowser && !CLIENT_PREFIX_RE.test(name) && GENERATED_SECRET_NAMES.has(name)) {
      return { name, source: "generated_secret" };
    }
    if (!isRequired(signal, name)) return null;
    const supabaseField = ctx.supabase ? supabaseFieldFor(name, runsInBrowser) : null;
    if (supabaseField) {
      supabaseUsers.add(serviceId);
      return { name, source: "integration", ref: `${SUPABASE_INTEGRATION_ID}.${supabaseField}` };
    }
    if (signal === frontend && name in STATIC_BUILD_DEFAULTS) {
      return { name, source: "literal", value: STATIC_BUILD_DEFAULTS[name] };
    }
    if (usesObjectStorage && !runsInBrowser && STORAGE_ENV_RE.test(name)) {
      return askSecret(
        name,
        serviceId,
        `The app stores files in an S3-compatible bucket and reads "${name}". Paste the value from your AWS S3, Cloudflare R2 or other S3-compatible bucket.`,
      );
    }
    return askSecret(name, serviceId, prompt);
  };

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
    // Prisma and Drizzle migrations are executed by ShipFix. Other tools still need setup.
    if (migrationTool !== "none" && migrationTool !== "prisma" && migrationTool !== "drizzle") {
      needsSetup = true;
    }
  }

  // ── Managed Redis (Upstash) ────────────────────────────────────────────────
  if (wantsRedis) {
    const redisRefs = [backend, next].flatMap((s) => (s ? refsFor(s) : [])).filter((n) => redisFieldFor(n));
    managed.push({
      id: "cache",
      kind: "redis",
      mode: "provision",
      provider: "upstash",
      exposesEnv: redisRefs.find((n) => redisFieldFor(n) === "connectionUrl") ?? redisRefs[0] ?? "REDIS_URL",
      migration: "none",
    });
    deployOrder.push("cache");
    verification.push({ serviceId: "cache", check: "db_connect" });
  }
  const wireRedis = (env: EnvVar[], serviceId: string, name: string): boolean => {
    const field = wantsRedis ? redisFieldFor(name) : null;
    if (!field) return false;
    env.push({ name, source: "generated_from_managed", ref: `cache.${field}` });
    wiring.push({ fromServiceId: "cache", fromField: field, toServiceId: serviceId, toEnvName: name });
    return true;
  };

  // ── Backend (Render web service: Node, Python, or Dockerfile) ─────────────
  if (backend) {
    const runtime = backendRuntime(backend) ?? "node_api";
    const env: EnvVar[] = [];
    for (const name of refsFor(backend)) {
      if (name === "PORT") {
        env.push({ name, source: "provider_injected" });
      } else if (wantsPostgres && DB_URL_RE.test(name)) {
        env.push({ name, source: "generated_from_managed", ref: "db.connectionUrl" });
        wiring.push({ fromServiceId: "db", fromField: "connectionUrl", toServiceId: "api", toEnvName: name });
      } else if (wireRedis(env, "api", name)) {
        // wired to the Upstash database
      } else if (FRONTEND_ORIGIN_RE.test(name) && (frontend || next)) {
        // Deferred wiring: backend deploys before the frontend URL exists.
        // A3 resolves web.origin after the frontend is live (Render setEnv).
        env.push({ name, source: "generated_from_service", ref: "web.origin" });
        wiring.push({
          fromServiceId: "web",
          fromField: "origin",
          toServiceId: "api",
          toEnvName: name,
        });
      } else {
        const v = unwiredEnv(
          backend,
          "api",
          name,
          `The backend requires the environment variable "${name}". ShipFix cannot derive its value from the repo; provide it before deploying.`,
          false,
        );
        if (v) env.push(v);
      }
    }

    const top = topHealthCandidate(backend.routeCandidates);
    const healthCheckPath = top ? normalizeRoutePath(top.path) : null;
    const healthCandidates = backend.routeCandidates
      .filter((c) => c.method === "GET" || c.method === "HEAD" || c.method === "ALL")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((c) => normalizeRoutePath(c.path));
    if (!healthCheckPath && runtime !== "docker_service") needsSetup = true; // validator: backend_health_ungrounded
    if (runtime === "docker_service" && !healthCheckPath) {
      blockers.push({
        severity: "warning",
        title: "Container health is not verifiable",
        explanation:
          "ShipFix builds this service from its Dockerfile and can confirm the container starts and listens, but found no HTTP route to check that the app itself answers.",
        action: "Add a health route (e.g. /health returning 2xx) so ShipFix can verify the service after deploying.",
        autoFixable: false,
        evidence: backend.evidence,
      });
    }

    const commands =
      runtime === "node_api"
        ? {
            install: pmCommand(backend, "install"),
            build: backend.scripts.build ? pmCommand(backend, "build") : null,
            start: pmCommand(backend, "start"),
          }
        : runtime === "python_api" && backend.inferredRun
          ? { install: backend.inferredRun.install, build: null, start: backend.inferredRun.start }
          : { install: null, build: null, start: null };

    services.push({
      id: "api",
      type: runtime,
      provider: "render",
      rootDir: backend.rootDir,
      ...(runtime === "node_api" ? {} : { framework: backend.framework }),
      ...commands,
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

  // ── Server-rendered app (Vercel frontend_ssr) — standalone or + separate Node API ─
  if (next) {
    const env: EnvVar[] = [];
    for (const name of refsFor(next)) {
      if (name === "PORT") {
        env.push({ name, source: "provider_injected" });
      } else if (wantsPostgres && DB_URL_RE.test(name)) {
        // Prefer DB on the API when both exist; still wire Next if it refs DB.
        env.push({ name, source: "generated_from_managed", ref: "db.connectionUrl" });
        wiring.push({ fromServiceId: "db", fromField: "connectionUrl", toServiceId: "web", toEnvName: name });
      } else if (wireRedis(env, "web", name)) {
        // wired to the Upstash database
      } else if (API_URL_RE.test(name) && backend) {
        env.push({ name, source: "generated_from_service", ref: "api.publicUrl" });
        wiring.push({ fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: name });
      } else {
        const v = unwiredEnv(
          next,
          "web",
          name,
          `The app requires the environment variable "${name}". ShipFix cannot derive its value from the repo; provide it before deploying.`,
          false,
        );
        if (v) env.push(v);
      }
    }

    // API-route health is OPTIONAL for Next: the primary proof of life is
    // frontend_loads. Only pin a health path when a dedicated health-style API
    // route exists — probing an arbitrary data route could fail a healthy app.
    // When a separate backend exists, backend health_path is the API proof.
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
      framework: next.framework,
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
    if (backend && services.some((s) => s.id === "api" && s.healthCheckPath)) {
      verification.push({ serviceId: "api", check: "cors_from", target: "web" });
    }

    const hardcoded = ctx.hardcodedUrls.filter((u) => u.service === next.rootDir);
    if (hardcoded.length > 0) {
      needsSetup = true;
      blockers.push({
        severity: "needs_input",
        title: backend ? "Frontend hardcodes a local URL" : "App hardcodes a local URL",
        explanation: backend
          ? `The frontend contains hardcoded local URL(s) (${hardcoded
              .map((u) => u.value)
              .slice(0, 3)
              .join(", ")}). After deployment it would still call localhost, so the live app would not reach the backend.`
          : `The app contains hardcoded local URL(s) (${hardcoded
              .map((u) => u.value)
              .slice(0, 3)
              .join(", ")}). After deployment it would still call localhost.`,
        action: backend
          ? "Replace the hardcoded URL with an environment variable (for example NEXT_PUBLIC_API_URL) and rerun the plan."
          : "Replace the hardcoded URL with an environment variable and rerun the plan.",
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
        const v = unwiredEnv(
          frontend,
          "web",
          name,
          `The frontend build requires the environment variable "${name}". Provide its value before deploying.`,
          true,
        );
        if (v) env.push(v);
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

  // ── Background workers (Render) — same code and env as their server ───────
  const workerServices: PlanService[] = [];
  for (const [signal, serverId] of [[backend, "api"], [next, "web"]] as const) {
    const procs = signal?.workers ?? [];
    if (!signal || !procs.length) continue;
    if (signal.language !== "node" && !(signal.language === "python" && signal.inferredRun)) continue;
    const server = services.find((s) => s.id === serverId);
    if (!server) continue;
    for (const proc of procs) {
      const start = proc.script ? `${pmCommand(signal, "install").split(" ")[0]} run ${proc.script}` : proc.command;
      if (!start) continue;
      const id = procs.length === 1 ? "worker" : `worker-${proc.name}`;
      if (services.some((s) => s.id === id) || workerServices.some((s) => s.id === id)) continue;
      // Origins of a not-yet-deployed frontend are wired to web services only.
      const env = server.env.filter((e) => !(e.source === "generated_from_service" && e.ref?.startsWith("web.")));
      for (const w of wiring.filter((w) => w.toServiceId === serverId && env.some((e) => e.name === w.toEnvName))) {
        wiring.push({ ...w, toServiceId: id });
      }
      workerServices.push({
        id,
        type: "worker",
        provider: "render",
        rootDir: signal.rootDir,
        runtime: signal.language === "python" ? "python" : "node",
        install: signal.language === "python" ? (signal.inferredRun?.install ?? null) : pmCommand(signal, "install"),
        build: signal.language === "node" && signal.scripts.build ? pmCommand(signal, "build") : null,
        start,
        outputDir: null,
        healthCheckPath: null,
        healthCandidates: [],
        env,
        evidence: proc.evidence,
      });
      deployOrder.push(id);
    }
  }
  if (workerServices.length) {
    services.push(...workerServices);
    blockers.push({
      severity: "warning",
      title: "Background worker runs on a paid Render plan",
      explanation: `The app runs ${workerServices.length === 1 ? "a background process" : `${workerServices.length} background processes`} beside its server (${workerServices.map((s) => s.start).join("; ")}). Render has no free plan for background workers, so ShipFix creates ${workerServices.length === 1 ? "it" : "them"} on the Starter plan, which Render bills to your account.`,
      action: "Make sure your Render account has billing set up before deploying.",
      autoFixable: false,
      evidence: workerServices.flatMap((s) => s.evidence),
    });
  }

  if (usesObjectStorage) {
    blockers.push({
      severity: "warning",
      title: "Uses your own file storage bucket",
      explanation:
        "The app uploads or reads files through an S3-compatible client. ShipFix doesn't create storage buckets yet, so the deployed app uses the bucket whose credentials you provide.",
      action: "Have an AWS S3, Cloudflare R2 or other S3-compatible bucket ready and paste its credentials when asked.",
      autoFixable: false,
      evidence: ctx.dataNeeds.filter((d) => d.kind === "object_storage").flatMap((d) => d.evidence),
    });
  }

  const parts = [
    next ? `${SSR_LABEL[next.framework] ?? next.framework} app on Vercel` : null,
    frontend ? `${frontend.framework} frontend on Vercel` : null,
    backend ? `${RUNTIME_LABEL[backend.framework] ?? `${backend.framework} API`} on Render` : null,
    wantsPostgres ? "Neon Postgres" : null,
    wantsRedis ? "Upstash Redis" : null,
    workerServices.length ? `background worker${workerServices.length > 1 ? "s" : ""} on Render` : null,
    usesObjectStorage ? "your S3-compatible bucket" : null,
    supabaseUsers.size ? "your existing Supabase project" : null,
  ].filter(Boolean);

  const integrations: PlanIntegration[] = [];
  if (supabaseUsers.size && ctx.supabase) {
    const migrations = ctx.supabase.migrations ?? [];
    integrations.push({
      id: SUPABASE_INTEGRATION_ID,
      provider: "supabase",
      projectRef: ctx.supabase.projectRef,
      ...(migrations.length ? { migrations } : {}),
    });
    if (!ctx.supabase.projectRef) {
      needsSetup = true;
      questions.push(supabaseProjectQuestion([...supabaseUsers]));
    }
    if (migrations.length) {
      blockers.push({
        severity: "warning",
        title: "Applies your pending Supabase migrations",
        explanation: `The repo has ${migrations.length} migration${migrations.length === 1 ? "" : "s"} in supabase/migrations. Before deploying, ShipFix compares them with your project's migration history and applies only the newer ones, each in its own transaction. It creates a restore point first; if your Supabase plan can't make one, it applies only migrations that don't drop or delete anything.`,
        action: "Nothing to do if your project is up to date. Review new migrations before deploying if they change existing data.",
        autoFixable: false,
        evidence: [`supabase/migrations (${migrations.length} files)`],
      });
    }
  }
  const openTables = ctx.supabase?.tablesWithoutRls ?? [];
  if (openTables.length) {
    const shown = openTables.slice(0, 5).join(", ") + (openTables.length > 5 ? ` and ${openTables.length - 5} more` : "");
    blockers.push({
      severity: "warning",
      title: "Database tables without row-level security",
      explanation: `Your Supabase migrations create ${openTables.length === 1 ? "a public table" : `${openTables.length} public tables`} (${shown}) without enabling row-level security. Anyone with the app's public anon key, which ships in the browser, can read and change ${openTables.length === 1 ? "it" : "them"}.`,
      action: `Add a migration with "alter table public.<table> enable row level security;" and policies for who may read and write each table.`,
      autoFixable: false,
      evidence: openTables.slice(0, 10).map((t) => `public.${t}`),
    });
  }

  return {
    goal: `Deploy ${ctx.repoFullName}: ${parts.join(" + ")}.`,
    classification: needsSetup ? "needs_setup" : "deployable",
    services,
    managed,
    integrations,
    wiring,
    deployOrder,
    questions,
    blockers,
    verification,
    confidence: needsSetup ? 0.7 : 0.95,
    planSource: "deterministic",
  };
}
