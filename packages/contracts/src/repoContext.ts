import { z } from "zod";

/**
 * RepoContext — the deterministic, factual description of a repository.
 *
 * Produced by the (future) `@shipfix/analyzer` via read-only static analysis.
 * This is the ONLY thing the LLM planner is given as input. It must never
 * contain secret VALUES — only variable names and references, plus
 * browser-public values that already ship in the client bundle (publicEnv).
 */

export const ServiceRole = z.enum([
  "frontend",
  "backend",
  "fullstack",
  "worker",
  "unknown",
]);
export type ServiceRole = z.infer<typeof ServiceRole>;

export const ServiceLanguage = z.enum([
  "node",
  "python",
  "go",
  "rust",
  "docker",
  "static",
  "unknown",
]);
export type ServiceLanguage = z.infer<typeof ServiceLanguage>;

export const PackageManager = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "poetry",
  "uv",
  "none",
]);
export type PackageManager = z.infer<typeof PackageManager>;

/** HTTP route discovered by static analysis (names only — never executed). */
export const RouteCandidate = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "ALL"]),
  path: z.string(),
  kind: z.enum(["explicit", "inferred"]).default("explicit"),
  /** file path or file:line that justifies this route. */
  evidence: z.array(z.string()).default([]),
  /** Higher = more likely a health/readiness probe target. */
  score: z.number().optional(),
});
export type RouteCandidate = z.infer<typeof RouteCandidate>;

/** A candidate deployable unit discovered in the repo. */
export const ServiceSignal = z.object({
  /** Relative path of this unit's root (e.g. "", "apps/web", "server"). */
  rootDir: z.string(),
  language: ServiceLanguage,
  /** Free-form framework id: vite | next | express | fastify | fastapi | django | ... */
  framework: z.string(),
  role: ServiceRole,
  packageManager: PackageManager,
  /** Declared scripts (package.json scripts / Makefile targets / etc). */
  scripts: z.record(z.string()).default({}),
  entrypoints: z.array(z.string()).default([]),
  hasDockerfile: z.boolean().default(false),
  /** Migration tool the Dockerfile (or the entrypoint script it copies) runs before the server starts. */
  imageMigrates: z.enum(["django", "alembic"]).optional(),
  /** GET/POST routes found in entrypoints and nearby route files. */
  routeCandidates: z.array(RouteCandidate).default([]),
  /**
   * Install/start commands derived from code evidence for runtimes without a
   * scripts map (Python): a Procfile, `app = FastAPI()`, a Streamlit entry file...
   */
  inferredRun: z
    .object({
      install: z.string(),
      start: z.string(),
      /**
       * Schema migration to run before each start (Procfile `release:`,
       * `python manage.py migrate`, `alembic upgrade head`).
       */
      release: z.string().optional(),
      evidence: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * Background processes that run beside the web process from the same code:
   * a package.json `worker` script (run via the package manager) or a
   * Procfile `worker:` line (run verbatim).
   */
  workers: z
    .array(
      z.object({
        name: z.string(),
        script: z.string().optional(),
        command: z.string().optional(),
        evidence: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  /** File paths (and optionally :line) that justify the above classification. */
  evidence: z.array(z.string()).default([]),
});
export type ServiceSignal = z.infer<typeof ServiceSignal>;

export const DataNeed = z.object({
  kind: z.enum(["postgres", "mysql", "redis", "object_storage", "sqlite_local"]),
  detectedFrom: z.enum(["prisma", "drizzle", "sequelize", "django", "alembic", "env_ref", "dep", "code"]),
  migrationTool: z
    .enum(["prisma", "drizzle", "django", "alembic", "none"])
    .default("none"),
  evidence: z.array(z.string()).default([]),
  /**
   * Set when the store already exists on a platform the app talks to through
   * its own client (e.g. a Supabase project reached via SUPABASE_URL), so
   * ShipFix must not provision or wire a separate one.
   */
  hostedBy: z.enum(["supabase"]).optional(),
});
export type DataNeed = z.infer<typeof DataNeed>;

/** An environment variable REFERENCED by code (names only — never values). */
export const EnvRef = z.object({
  name: z.string(),
  /** rootDir of the service that references it. */
  service: z.string(),
  required: z.boolean().default(true),
});
export type EnvRef = z.infer<typeof EnvRef>;

/** A hardcoded URL/port smell that likely blocks a real deployment. */
export const HardcodedUrl = z.object({
  value: z.string(),
  file: z.string(),
  service: z.string(),
});
export type HardcodedUrl = z.infer<typeof HardcodedUrl>;

/**
 * A browser-public env value committed to the repo (e.g. `VITE_SUPABASE_URL`
 * in `.env`). Only public-prefixed names whose values are bundled into the
 * client anyway; the analyzer rejects anything that looks like a credential.
 */
export const PublicEnvValue = z.object({
  name: z.string(),
  value: z.string(),
  file: z.string(),
  /** rootDir of the service the env file belongs to. */
  service: z.string(),
});
export type PublicEnvValue = z.infer<typeof PublicEnvValue>;

export const CompanionKind = z.enum([
  "desktop",
  "mobile",
  "browser_extension",
  "cli",
  "mcp_server",
  "tooling",
  "docs",
  "example",
  "scripts",
]);
export type CompanionKind = z.infer<typeof CompanionKind>;

/**
 * A package that lives in the repo but is not a web deploy target (desktop or
 * mobile client, CLI, agent tooling, examples, helper scripts). Listed so the
 * user can see what ShipFix intentionally leaves out.
 */
export const Companion = z.object({
  rootDir: z.string(),
  kind: CompanionKind,
  evidence: z.array(z.string()).default([]),
});
export type Companion = z.infer<typeof Companion>;

export const SupabaseMigration = z.object({
  version: z.string(),
  name: z.string(),
  file: z.string(),
});
export type SupabaseMigration = z.infer<typeof SupabaseMigration>;

/** The app talks to an existing Supabase project. */
export const SupabaseUsage = z.object({
  /** 20-char project ref (the `<ref>.supabase.co` subdomain), when the repo names it. */
  projectRef: z.string().nullable(),
  /** `supabase/migrations/<version>_<name>.sql`, oldest first. */
  migrations: z.array(SupabaseMigration).optional(),
  /** Public tables the migrations create without enabling row-level security. */
  tablesWithoutRls: z.array(z.string()).optional(),
  evidence: z.array(z.string()).default([]),
});
export type SupabaseUsage = z.infer<typeof SupabaseUsage>;

export const RepoContext = z.object({
  repoFullName: z.string(),
  commitSha: z.string(),
  /** Pruned file tree (no node_modules, build output, etc). */
  fileTree: z.array(z.string()),
  services: z.array(ServiceSignal),
  dataNeeds: z.array(DataNeed).default([]),
  envRefs: z.array(EnvRef).default([]),
  hardcodedUrls: z.array(HardcodedUrl).default([]),
  publicEnv: z.array(PublicEnvValue).default([]),
  companions: z.array(Companion).default([]),
  supabase: SupabaseUsage.optional(),
  monorepoTool: z
    .enum(["turbo", "nx", "pnpm_workspace", "none"])
    .default("none"),
});
export type RepoContext = z.infer<typeof RepoContext>;
