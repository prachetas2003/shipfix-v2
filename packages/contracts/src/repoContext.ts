import { z } from "zod";

/**
 * RepoContext — the deterministic, factual description of a repository.
 *
 * Produced by the (future) `@shipfix/analyzer` via read-only static analysis.
 * This is the ONLY thing the LLM planner is given as input. It must never
 * contain secret VALUES — only variable names and references.
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
  /** GET/POST routes found in entrypoints and nearby route files. */
  routeCandidates: z.array(RouteCandidate).default([]),
  /** File paths (and optionally :line) that justify the above classification. */
  evidence: z.array(z.string()).default([]),
});
export type ServiceSignal = z.infer<typeof ServiceSignal>;

export const DataNeed = z.object({
  kind: z.enum(["postgres", "mysql", "redis", "object_storage", "sqlite_local"]),
  detectedFrom: z.enum(["prisma", "drizzle", "sequelize", "env_ref", "dep", "code"]),
  migrationTool: z
    .enum(["prisma", "drizzle", "django", "alembic", "none"])
    .default("none"),
  evidence: z.array(z.string()).default([]),
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

export const RepoContext = z.object({
  repoFullName: z.string(),
  commitSha: z.string(),
  /** Pruned file tree (no node_modules, build output, etc). */
  fileTree: z.array(z.string()),
  services: z.array(ServiceSignal),
  dataNeeds: z.array(DataNeed).default([]),
  envRefs: z.array(EnvRef).default([]),
  hardcodedUrls: z.array(HardcodedUrl).default([]),
  monorepoTool: z
    .enum(["turbo", "nx", "pnpm_workspace", "none"])
    .default("none"),
});
export type RepoContext = z.infer<typeof RepoContext>;
