import {
  bigint,
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * ShipFix v2 control-plane schema (Postgres / Drizzle).
 *
 * Invariants baked into the design:
 *  - run_events is append-only and powers the live UI + audit trail.
 *  - Secret VALUES live only in envelope-encrypted (`bytea`) columns; never in
 *    plans.doc, deployed_resources.url, or run_events.
 */

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

// ── Identity ───────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  clerkId: text("clerk_id").unique(),
  login: text("login").notNull(),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Encrypted provider credentials (Vercel/Render/Neon/GitHub App/...) ───────
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    // envelope encryption: KMS-wrapped data key + AES-GCM ciphertext + IV
    encDek: bytea("enc_dek").notNull(),
    encBlob: bytea("enc_blob").notNull(),
    encIv: bytea("enc_iv").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqAccount: uniqueIndex("provider_accounts_unique").on(
      t.userId,
      t.provider,
      t.externalId,
    ),
  }),
);

// ── A connected repo ─────────────────────────────────────────────────────────
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** When true, GitHub push webhooks on defaultBranch start a deploy run. */
    autoDeployOnPush: boolean("auto_deploy_on_push").notNull().default(false),
    /** GitHub App installation id that covers this repo (for private clone + push). */
    githubInstallationId: text("github_installation_id"),
    /** Denormalized snapshot of the last good deployment graph (for dashboard). */
    liveGraph: jsonb("live_graph"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqProject: uniqueIndex("projects_unique").on(t.userId, t.repoFullName),
  }),
);

// ── One end-to-end attempt: analyze -> plan -> deploy -> verify ──────────────
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  trigger: text("trigger").notNull(), // 'manual' | 'push' | 'retry'
  mode: text("mode").notNull(), // 'analyze_only' | 'deploy'
  status: text("status").notNull(), // mirrors RunStage in @shipfix/contracts
  temporalId: text("temporal_id"),
  planId: uuid("plan_id"),
  costCents: integer("cost_cents").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ── Append-only timeline (live UI + audit) ──────────────────────────────────
export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(), // RunEventType
    stage: text("stage"), // RunStage
    level: text("level").notNull().default("info"),
    message: text("message").notNull(), // redacted before insert
    data: jsonb("data"), // redacted before insert
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqSeq: uniqueIndex("run_events_seq_unique").on(t.runId, t.seq),
  }),
);

// ── Plans (versioned; recovery may produce new versions) ─────────────────────
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    doc: jsonb("doc").notNull(), // full DeploymentPlan (validated)
    planner: text("planner").notNull(), // 'gemini' | 'claude' | 'mock'
    confidence: real("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqVersion: uniqueIndex("plans_version_unique").on(t.runId, t.version),
  }),
);

// ── Concrete resources created in the world (for verify/wiring/teardown) ─────
export const deployedResources = pgTable("deployed_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(), // matches DeploymentPlan service/managed id
  kind: text("kind").notNull(), // 'service' | 'managed_db' | 'managed_redis'
  provider: text("provider").notNull(),
  externalId: text("external_id"),
  url: text("url"), // public/non-secret host URL — NEVER a secret value
  status: text("status").notNull(), // 'provisioning' | 'live' | 'failed'
  /** Env var name this resource exposes for wiring (e.g. "DATABASE_URL"). */
  exposesEnv: text("exposes_env"),
  // Envelope-encrypted value of `exposesEnv` (e.g. the Postgres connection
  // string). A connection string is a SECRET, so it lives only here, sealed —
  // never in `url`, run_events, or LLM prompts.
  encBlob: bytea("enc_blob"),
  encIv: bytea("enc_iv"),
  encDek: bytea("enc_dek"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Answers to human-in-the-loop questions (secret answers encrypted) ────────
export const runInputs = pgTable(
  "run_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    valuePlain: text("value_plain"), // only for non-secret answers
    encBlob: bytea("enc_blob"),
    encIv: bytea("enc_iv"),
    encDek: bytea("enc_dek"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqQuestion: uniqueIndex("run_inputs_run_question_unique").on(t.runId, t.questionId),
  }),
);

// ── Durable per-project production env (single environment for MVP) ──────────
export const projectEnvVars = pgTable(
  "project_env_vars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isSecret: boolean("is_secret").notNull().default(true),
    valuePlain: text("value_plain"),
    encBlob: bytea("enc_blob"),
    encIv: bytea("enc_iv"),
    encDek: bytea("enc_dek"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqName: uniqueIndex("project_env_vars_project_name_unique").on(t.projectId, t.name),
  }),
);

// Alpha safety ledger for backend-only LLM usage. Stores metadata only: no
// prompts, no provider keys, no repo secrets, no model output.
export const llmUsage = pgTable("llm_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  operation: text("operation").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  estimatedCostCents: real("estimated_cost_cents").notNull().default(0),
  success: boolean("success").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  taskQueue: text("task_queue").notNull(),
  temporalAddress: text("temporal_address").notNull(),
  temporalNamespace: text("temporal_namespace").notNull().default("default"),
  status: text("status").notNull().default("polling"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta"),
});

export const schema = {
  users,
  providerAccounts,
  projects,
  runs,
  runEvents,
  plans,
  deployedResources,
  runInputs,
  projectEnvVars,
  llmUsage,
  workerHeartbeats,
};
