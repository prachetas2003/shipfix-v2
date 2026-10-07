import { z } from "zod";

/**
 * DeploymentPlan — what to build, deploy, provision and wire.
 *
 * The LLM planner PROPOSES a plan; deterministic code (the validator) DISPOSES.
 * Every value-bearing field that touches infra or secrets must be verifiable
 * against the repo or a real command run, never trusted on the model's word.
 *
 * Only providers/types with a real adapter behind them belong here. Do NOT add
 * enum values for providers we cannot actually execute — that creates the
 * "support illusion" that sank v1.
 */

/** Providers we intend to back with a real adapter. Extend only when implemented. */
export const PlanProvider = z.enum([
  "vercel",
  "render",
  "railway", // TODO: adapter not implemented yet — keep out of planner output until it is.
]);
export type PlanProvider = z.infer<typeof PlanProvider>;

export const ServiceType = z.enum([
  "frontend_static",
  "frontend_ssr",
  "node_api",
  "python_api",
  "worker",
  "docker_service",
]);
export type ServiceType = z.infer<typeof ServiceType>;

/** Long-running HTTP services deployed as Render web services. */
export const RENDER_WEB_SERVICE_TYPES: readonly ServiceType[] = ["node_api", "python_api", "docker_service"];

export function isWebBackendType(type: string | undefined): boolean {
  return (RENDER_WEB_SERVICE_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * Server-rendered frameworks deployed to Vercel as frontend_ssr, mapped to the
 * Vercel framework preset. null = no preset: the build writes Vercel's Build
 * Output API itself (Nitro with NITRO_PRESET=vercel).
 */
export const VERCEL_SSR_PRESETS: Readonly<Record<string, string | null>> = {
  next: "nextjs",
  nuxt: "nuxtjs",
  remix: "remix",
  "react-router": "react-router",
  sveltekit: "sveltekit",
  "tanstack-start": null,
};

export function isVercelSsrFramework(framework: string | undefined): boolean {
  return framework !== undefined && Object.prototype.hasOwnProperty.call(VERCEL_SSR_PRESETS, framework);
}

export const ManagedKind = z.enum(["postgres", "redis", "object_storage"]);
export type ManagedKind = z.infer<typeof ManagedKind>;

/**
 * Where an env var's value comes from. Secret values are resolved at deploy
 * time by the worker — never stored in the plan, never sent to the LLM.
 */
export const EnvVarSource = z.enum([
  "user_secret", // user must supply a value (asked via a PlanQuestion)
  "generated_from_service", // e.g. backend public URL -> frontend build env
  "generated_from_managed", // e.g. Neon DATABASE_URL -> backend env
  "provider_injected", // platform provides it (PORT, etc.)
  "literal", // a known, non-secret default
  "generated_secret", // random value ShipFix creates once per project and keeps sealed (CRON_SECRET, AUTH_SECRET)
  "integration", // read at deploy time from a connected existing project (ref "supabase.serviceRoleKey")
]);
export type EnvVarSource = z.infer<typeof EnvVarSource>;

/** Values an integration can supply, addressed as `<integrationId>.<field>`. */
export const IntegrationField = z.enum(["url", "anonKey", "serviceRoleKey", "projectRef"]);
export type IntegrationField = z.infer<typeof IntegrationField>;

/** Fields that are secret and must never reach a browser bundle. */
export const SECRET_INTEGRATION_FIELDS: ReadonlySet<IntegrationField> = new Set(["serviceRoleKey"]);

/**
 * An existing external project the app already talks to (not provisioned or
 * deployed by ShipFix). Env values are read from it at deploy time.
 */
export const PlanIntegration = z.object({
  id: z.string(),
  provider: z.enum(["supabase"]),
  /** Null when the repo doesn't say which project; resolved at deploy time. */
  projectRef: z.string().nullable(),
  /**
   * The repo's `supabase/migrations` files, oldest first. ShipFix applies the
   * ones the project's migration history doesn't have yet.
   */
  migrations: z.array(z.object({ version: z.string(), name: z.string(), file: z.string() })).optional(),
});
export type PlanIntegration = z.infer<typeof PlanIntegration>;

export const EnvVar = z.object({
  name: z.string(),
  source: EnvVarSource,
  /**
   * For generated_*: "serviceId.publicUrl" | "serviceId.origin" | "managedId.connectionUrl"
   * (Redis also "managedId.restUrl" | "managedId.restToken").
   * For integration: "integrationId.<IntegrationField>".
   */
  ref: z.string().optional(),
  /** ONLY for source === "literal". Must never carry a secret. */
  value: z.string().optional(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const PlanService = z.object({
  /** Stable id referenced by wiring, deployOrder, verification and resources. */
  id: z.string(),
  type: ServiceType,
  provider: PlanProvider,
  rootDir: z.string(),
  /**
   * Detected framework ("next", "tanstack-start", ...). Picks the Vercel preset
   * for frontend_ssr. Plans persisted before this field are Next.js.
   */
  framework: z.string().optional(),
  /** Workers only: the runtime their code needs (web types imply it). */
  runtime: z.enum(["node", "python"]).optional(),
  install: z.string().nullable(),
  build: z.string().nullable(),
  start: z.string().nullable(),
  /** Static frontends only. */
  outputDir: z.string().nullable(),
  /** Backends only. */
  healthCheckPath: z.string().nullable(),
  /**
   * Backends only: every grounded GET route path detected in the repo, best
   * candidate first. The verifier may probe these as fallbacks when the
   * primary healthCheckPath does not respond 2xx. Never invented paths.
   * Optional because plans persisted before this field exist without it.
   */
  healthCandidates: z.array(z.string()).optional(),
  env: z.array(EnvVar).default([]),
  evidence: z.array(z.string()).default([]),
});
export type PlanService = z.infer<typeof PlanService>;

export const ManagedService = z.object({
  id: z.string(),
  kind: ManagedKind,
  mode: z.enum(["provision", "connect_existing"]),
  /** Set when mode === "provision". */
  provider: z.enum(["neon", "supabase", "upstash"]).optional(),
  /** Env var name this service exposes, e.g. "DATABASE_URL". */
  exposesEnv: z.string(),
  migration: z.enum(["prisma", "drizzle", "django", "alembic", "none"]).default("none"),
});
export type ManagedService = z.infer<typeof ManagedService>;

/** Fields a managed service exposes as `<managedId>.<field>`, by kind. */
export const MANAGED_ENV_FIELDS: Readonly<Record<ManagedKind, readonly string[]>> = {
  postgres: ["connectionUrl"],
  // restUrl/restToken serve @upstash/redis and Vercel KV style clients.
  redis: ["connectionUrl", "restUrl", "restToken"],
  object_storage: ["connectionUrl"],
};

/** First-class service-graph edge: source field -> target service env var. */
export const WiringEdge = z.object({
  fromServiceId: z.string(),
  fromField: z.enum(["publicUrl", "connectionUrl", "origin", "restUrl", "restToken"]),
  toServiceId: z.string(),
  toEnvName: z.string(),
});
export type WiringEdge = z.infer<typeof WiringEdge>;

/** A human-in-the-loop question the plan needs answered before/while deploying. */
export const PlanQuestion = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(["secret", "choice", "confirm"]),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  /** Service ids that cannot deploy until this is answered. */
  blocksServiceIds: z.array(z.string()).default([]),
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

/** A reason the app can't (fully) deploy — the core of the diagnosis output. */
export const Blocker = z.object({
  severity: z.enum(["fatal", "needs_input", "warning"]),
  title: z.string(),
  /** Plain-English, user-facing explanation. */
  explanation: z.string(),
  /** Concrete action the user (or ShipFix) can take. */
  action: z.string(),
  /** Whether ShipFix could resolve it via a reviewable config PR. */
  autoFixable: z.boolean().default(false),
  evidence: z.array(z.string()).default([]),
});
export type Blocker = z.infer<typeof Blocker>;

/** What "working" means for this app — checked live by the verifier. */
export const VerificationCheck = z.object({
  serviceId: z.string(),
  check: z.enum([
    "http_2xx",
    "health_path",
    "frontend_loads",
    "cors_from",
    "db_connect",
  ]),
  target: z.string().optional(),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

/** GREEN / YELLOW / RED, as the product's central honesty primitive. */
export const PlanClassification = z.enum([
  "deployable", // GREEN: validated, can auto-deploy
  "needs_setup", // YELLOW: actionable setup required (secrets, DB choice)
  "diagnose_only", // RED: cannot auto-deploy; diagnosis is the deliverable
]);
export type PlanClassification = z.infer<typeof PlanClassification>;

/**
 * Where the plan came from. Repos fully inside the supported slice are planned
 * deterministically (reproducible, no model in the loop); everything else is
 * proposed by the LLM and disposed by the validator.
 */
export const PlanSource = z.enum(["deterministic", "llm", "llm_fallback"]);
export type PlanSource = z.infer<typeof PlanSource>;

export const DeploymentPlan = z.object({
  goal: z.string(),
  classification: PlanClassification,
  services: z.array(PlanService),
  managed: z.array(ManagedService).default([]),
  /** Optional because plans persisted before integrations existed lack it. */
  integrations: z.array(PlanIntegration).optional(),
  wiring: z.array(WiringEdge).default([]),
  /** Topologically ordered ids of services + managed services. */
  deployOrder: z.array(z.string()),
  questions: z.array(PlanQuestion).default([]),
  blockers: z.array(Blocker).default([]),
  verification: z.array(VerificationCheck).default([]),
  confidence: z.number().min(0).max(1),
  /** Set by the planner pipeline, never by the model itself. */
  planSource: PlanSource.optional(),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;
