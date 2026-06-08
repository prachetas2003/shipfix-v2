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
]);
export type EnvVarSource = z.infer<typeof EnvVarSource>;

export const EnvVar = z.object({
  name: z.string(),
  source: EnvVarSource,
  /** For generated_*: "serviceId.publicUrl" | "managedId.connectionUrl" | "serviceId.origin". */
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
  install: z.string().nullable(),
  build: z.string().nullable(),
  start: z.string().nullable(),
  /** Static frontends only. */
  outputDir: z.string().nullable(),
  /** Backends only. */
  healthCheckPath: z.string().nullable(),
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

/** First-class service-graph edge: source field -> target service env var. */
export const WiringEdge = z.object({
  fromServiceId: z.string(),
  fromField: z.enum(["publicUrl", "connectionUrl", "origin"]),
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

export const DeploymentPlan = z.object({
  goal: z.string(),
  classification: PlanClassification,
  services: z.array(PlanService),
  managed: z.array(ManagedService).default([]),
  wiring: z.array(WiringEdge).default([]),
  /** Topologically ordered ids of services + managed services. */
  deployOrder: z.array(z.string()),
  questions: z.array(PlanQuestion).default([]),
  blockers: z.array(Blocker).default([]),
  verification: z.array(VerificationCheck).default([]),
  confidence: z.number().min(0).max(1),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;
