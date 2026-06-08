import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { Client, Connection } from "@temporalio/client";
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import {
  createDb,
  deployedResources,
  plans,
  projects,
  providerAccounts,
  llmUsage,
  runEvents,
  runs,
} from "@shipfix/db";
import { createPostgresSink, createRunLogger } from "@shipfix/observability";
import { reconcileStuckRuns } from "@shipfix/workflow";
import { createSecretVaultFromEnv } from "@shipfix/secrets";
import { env } from "./env";
import { requireAdmin, requireAlphaUser, type AlphaUser } from "./auth";
import {
  deriveLayers,
  toSnapshotResources,
  verificationFromEvents,
  type PlanLite,
  type RawResourceRow,
} from "./snapshot";

/**
 * ShipFix control plane (API).
 *
 * HARD RULE: this process never executes untrusted repository code. All such
 * execution happens in @shipfix/sandbox, invoked only from worker activities.
 * The API only creates runs, starts the Temporal workflow, and tails the
 * append-only run_events table to the UI.
 */

const app = Fastify({ logger: true });
const db = createDb(env.DATABASE_URL);

// Browser app talks cross-origin in dev; SSE + JSON POST need CORS.
await app.register(cors, { origin: env.WEB_ORIGIN });

// ── Temporal client (lazy, cached) ───────────────────────────────────────────
let _client: Client | undefined;
async function temporal(): Promise<Client> {
  if (!_client) {
    const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
    _client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  }
  return _client;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "diagnosed"]);
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const NON_TERMINAL_STATUSES = ["queued", "analyzing", "planning", "validating", "awaiting_input", "provisioning", "deploying", "verifying"];
const ipStarts = new Map<string, number[]>();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateProject(
  userId: string,
  repoFullName: string,
  defaultBranch: string,
): Promise<{ id: string }> {
  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.repoFullName, repoFullName)))
    .limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(projects)
    .values({ userId, repoFullName, defaultBranch })
    .returning();
  return created;
}

/** Latest validated plan doc for a run (highest version), if any. */
async function loadPlanDoc(runId: string): Promise<PlanLite | null> {
  const [row] = await db
    .select({ doc: plans.doc })
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(desc(plans.version))
    .limit(1);
  return (row?.doc as PlanLite | null) ?? null;
}

/** Non-secret deployed resource rows for a run (never selects enc_* columns). */
async function loadResourceRows(runId: string): Promise<RawResourceRow[]> {
  return db
    .select({
      serviceId: deployedResources.serviceId,
      kind: deployedResources.kind,
      provider: deployedResources.provider,
      externalId: deployedResources.externalId,
      url: deployedResources.url,
      status: deployedResources.status,
      exposesEnv: deployedResources.exposesEnv,
      createdAt: deployedResources.createdAt,
    })
    .from(deployedResources)
    .where(eq(deployedResources.runId, runId));
}

async function loadVerificationForRun(runId: string) {
  const events = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq));
  return verificationFromEvents(events);
}

async function buildResourceSnapshotForRun(runId: string) {
  const plan = await loadPlanDoc(runId);
  const rows = await loadResourceRows(runId);
  const resources = toSnapshotResources(rows, plan);
  const verification = await loadVerificationForRun(runId);
  return {
    resources,
    verification,
    layers: deriveLayers(resources, plan, verification),
  };
}

async function userCanAccessRun(userId: string, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(projects.userId, userId)))
    .limit(1);
  return Boolean(row);
}

function backendConfigCheck() {
  const provider = process.env.LLM_PROVIDER ?? "";
  const providerKey =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider === "gemini"
          ? "GEMINI_API_KEY"
          : null;
  return {
    databaseUrl: Boolean(env.DATABASE_URL),
    alphaUsersConfigured: Boolean(env.ALPHA_USER_TOKENS),
    adminTokenConfigured: Boolean(env.SHIPFIX_ADMIN_TOKEN),
    masterKeyConfigured: Boolean(env.SHIPFIX_MASTER_KEY),
    llmProvider: provider || null,
    llmModelConfigured: Boolean(process.env.LLM_MODEL),
    llmProviderKeyConfigured: providerKey ? Boolean(process.env[providerKey]) : false,
    llmExpectedKeyEnv: providerKey,
    limits: {
      deployRunsPerUserPerDay: env.ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY,
      planAnalyzeRunsPerUserPerDay: env.ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY,
      activeDeployRunsPerUser: env.ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER,
      ipWindowMs: env.ALPHA_RATE_LIMIT_WINDOW_MS,
      maxRunStartsPerIpWindow: env.ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW,
    },
  };
}

/** Build the full beginner-facing snapshot for one run. */
async function buildRunSnapshot(runId: string): Promise<Record<string, unknown> | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return null;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .limit(1);

  const [plan, resourceRows, events] = await Promise.all([
    loadPlanDoc(runId),
    loadResourceRows(runId),
    db
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq)),
  ]);

  const resources = toSnapshotResources(resourceRows, plan);
  const verification = verificationFromEvents(events);
  const layers = deriveLayers(resources, plan, verification);

  return {
    run: {
      id: run.id,
      mode: run.mode,
      status: run.status,
      repoFullName: project?.repoFullName ?? null,
      branch: project?.defaultBranch ?? null,
      commitSha: run.commitSha,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      projectId: run.projectId,
    },
    plan,
    resources,
    verification,
    layers,
  };
}

async function reconcileStuckRunsSafely(reason: string) {
  try {
    const summary = await reconcileStuckRuns(db);
    if (summary.reconciled > 0) {
      app.log.warn({ reason, summary }, "reconciled stuck runs");
    }
    return summary;
  } catch (err) {
    app.log.error({ err, reason }, "stuck-run reconciliation failed");
    return null;
  }
}

/** Normalize "owner/repo" out of either field. */
function resolveRepoFullName(input: {
  repoFullName?: string;
  repoUrl?: string;
}): string | null {
  if (input.repoFullName && /^[^/\s]+\/[^/\s]+$/.test(input.repoFullName)) {
    return input.repoFullName;
  }
  if (input.repoUrl) {
    const m = input.repoUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

type RunMode = "analyze_only" | "plan" | "deploy";

/** Providers ShipFix can actually execute against in THIS build. */
const PROVISIONABLE_PROVIDERS = ["neon"] as const;
const DEPLOYABLE_PROVIDERS = ["render", "vercel"] as const;
const DEPLOYABLE_SERVICE_TYPES: Record<string, string[]> = {
  render: ["node_api"],
  vercel: ["frontend_static"],
};

type StartResult =
  | { ok: true; runId: string }
  | { ok: false; runId: string; code: string; message: string };

type LimitResult = { ok: true } | { ok: false; code: string; message: string };

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function countRows(query: Promise<Array<{ count: number | string }>>): Promise<number> {
  const rows = await query;
  return Number(rows[0]?.count ?? 0);
}

async function recordRateLimitRejection(args: {
  userId: string;
  projectId?: string;
  operation: string;
  code: string;
}): Promise<void> {
  await db.insert(llmUsage).values({
    userId: args.userId,
    projectId: args.projectId,
    runId: null,
    provider: "shipfix",
    model: "rate-limit",
    operation: args.operation,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostCents: 0,
    success: false,
    error: args.code,
  });
}

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - env.ALPHA_RATE_LIMIT_WINDOW_MS;
  const recent = (ipStarts.get(ip) ?? []).filter((t) => t >= windowStart);
  if (recent.length >= env.ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW) {
    ipStarts.set(ip, recent);
    return false;
  }
  recent.push(now);
  ipStarts.set(ip, recent);
  return true;
}

async function checkRunLimits(
  userId: string,
  projectId: string,
  mode: RunMode,
): Promise<LimitResult> {
  const since = startOfUtcDay();
  const modes = mode === "deploy" ? ["deploy"] : ["analyze_only", "plan"];
  const dailyLimit =
    mode === "deploy"
      ? env.ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY
      : env.ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY;
  const today = await countRows(
    db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(
        and(
          eq(projects.userId, userId),
          inArray(runs.mode, modes),
          gte(runs.startedAt, since),
        ),
      ),
  );
  if (today >= dailyLimit) {
    await recordRateLimitRejection({ userId, projectId, operation: mode, code: "daily_run_limit" });
    return {
      ok: false,
      code: "alpha_usage_limit",
      message: "You've reached the alpha usage limit. Try again later.",
    };
  }

  if (mode === "deploy") {
    const active = await countRows(
      db
        .select({ count: sql<number>`count(*)` })
        .from(runs)
        .innerJoin(projects, eq(runs.projectId, projects.id))
        .where(
          and(
            eq(projects.userId, userId),
            eq(runs.mode, "deploy"),
            inArray(runs.status, NON_TERMINAL_STATUSES),
          ),
        ),
    );
    if (active >= env.ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER) {
      await recordRateLimitRejection({ userId, projectId, operation: mode, code: "active_deploy_limit" });
      return {
        ok: false,
        code: "alpha_usage_limit",
        message: "You've reached the alpha usage limit. Try again later.",
      };
    }
  }

  return { ok: true };
}

/**
 * Create a run, seed its timeline, and start the Temporal workflow. Shared by
 * the analyze and plan routes — the only difference is `mode`. On a workflow
 * start failure the run is marked `failed` (never left orphaned in `queued`).
 */
async function startRun(
  mode: RunMode,
  user: AlphaUser,
  input: { repoFullName: string; branch: string; commitSha: string },
): Promise<StartResult> {
  const project = await getOrCreateProject(user.id, input.repoFullName, input.branch);
  const limits = await checkRunLimits(user.id, project.id, mode);
  if (!limits.ok) {
    return { ok: false, runId: "", code: limits.code, message: limits.message };
  }

  const [run] = await db
    .insert(runs)
    .values({
      projectId: project.id,
      commitSha: input.commitSha,
      trigger: "manual",
      mode,
      status: "queued",
    })
    .returning();

  // Seed the timeline immediately so the UI shows the run before the worker
  // picks it up (and so a start failure has somewhere to record itself).
  const logger = createRunLogger(run.id, createPostgresSink(db));
  await logger.stage("queued", `Run queued for ${input.repoFullName}`);

  const workflowId = `run-${run.id}`;
  try {
    const client = await temporal();
    await client.workflow.start("deploymentWorkflow", {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      args: [{ runId: run.id, mode }],
    });
    await db.update(runs).set({ temporalId: workflowId }).where(eq(runs.id, run.id));
    return { ok: true, runId: run.id };
  } catch (startErr) {
    await db
      .update(runs)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(runs.id, run.id));
    await logger.error(
      "Could not start the deployment workflow. Is the Temporal dev server running? (temporal server start-dev)",
      { error: startErr instanceof Error ? startErr.message : String(startErr) },
    );
    return {
      ok: false,
      runId: run.id,
      code: "workflow_start_failed",
      message: "Could not start the Temporal workflow. Is the Temporal dev server running?",
    };
  }
}

/** Build a Fastify handler that launches a run in the given mode. */
function runRouteHandler(mode: RunMode) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAlphaUser(request, reply, db, env);
    if (!user) return;

    const parsed = RunBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const repoFullName = resolveRepoFullName(parsed.data);
    if (!repoFullName) {
      return reply.status(400).send({
        error: "missing_repo",
        message: "Provide a repo as 'owner/repo' or a GitHub URL (repoFullName or repoUrl).",
      });
    }
    if (!checkIpRateLimit(request.ip)) {
      await recordRateLimitRejection({ userId: user.id, operation: mode, code: "ip_run_start_limit" });
      return reply.status(429).send({
        error: "alpha_usage_limit",
        message: "You've reached the alpha usage limit. Try again later.",
      });
    }

    try {
      const result = await startRun(mode, {
        id: user.id,
        login: user.login,
      }, {
        repoFullName,
        branch: parsed.data.branch ?? "main",
        commitSha: parsed.data.commitSha ?? "HEAD",
      });
      if (!result.ok) {
        if (!result.runId) {
          return reply.status(429).send({ error: result.code, message: result.message });
        }
        return reply.status(503).send({ runId: result.runId, error: result.code, message: result.message });
      }
      return reply.status(202).send({ runId: result.runId, repoFullName, mode });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({
        error: "internal",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, service: "shipfix-api" }));

const RunBody = z.object({
  // repoUrl is validated by resolveRepoFullName, not z.url() — callers may pass
  // "owner/repo" in either field, and a strict .url() would reject that.
  repoFullName: z.string().optional(),
  repoUrl: z.string().optional(),
  commitSha: z.string().optional(),
  branch: z.string().optional(),
});

// analyze_only: clone -> deterministic RepoContext.
app.post("/runs/analyze", runRouteHandler("analyze_only"));

// plan: clone -> RepoContext -> AI-proposed plan -> deterministic validation.
// No deployment is attempted; the validated plan is the deliverable.
app.post("/runs/plan", runRouteHandler("plan"));

// deploy: plan + REAL managed-service provisioning (e.g. Neon Postgres). No
// service deployment yet, so this ends as a diagnosis with provisioned infra.
app.post("/runs/deploy", runRouteHandler("deploy"));

// ── Provider credentials ───────────────────────────────────────────────────
// The control plane is trusted and may receive a plaintext credential here; it
// is sealed (envelope-encrypted) immediately and never logged or returned.
const ConnectBody = z.object({
  provider: z.string().min(1),
  values: z
    .record(z.string())
    .refine((v) => Object.keys(v).length > 0, "at least one credential field is required"),
});

app.post("/provider-accounts", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const parsed = ConnectBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }

  let vault: ReturnType<typeof createSecretVaultFromEnv>;
  try {
    vault = createSecretVaultFromEnv();
  } catch (e) {
    return reply.status(500).send({
      error: "vault_unconfigured",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const sealed = await vault.seal(JSON.stringify(parsed.data.values));

    const existing = await db
      .select()
      .from(providerAccounts)
      .where(and(eq(providerAccounts.userId, user.id), eq(providerAccounts.provider, parsed.data.provider)))
      .limit(1);

    if (existing[0]) {
      await db
        .update(providerAccounts)
        .set({ encDek: sealed.encDek, encBlob: sealed.encBlob, encIv: sealed.encIv })
        .where(eq(providerAccounts.id, existing[0].id));
      return reply.status(200).send({ id: existing[0].id, provider: parsed.data.provider, updated: true });
    }

    const [created] = await db
      .insert(providerAccounts)
      .values({
        userId: user.id,
        provider: parsed.data.provider,
        encDek: sealed.encDek,
        encBlob: sealed.encBlob,
        encIv: sealed.encIv,
      })
      .returning();
    return reply.status(201).send({ id: created.id, provider: parsed.data.provider });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: "internal", message: err instanceof Error ? err.message : String(err) });
  }
});

// What ShipFix can actually do right now, plus what this user has connected.
app.get("/providers", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const accounts = await db
    .select({ provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, user.id));
  return {
    connected: accounts.map((a) => a.provider),
    provisionable: PROVISIONABLE_PROVIDERS,
    deployable: DEPLOYABLE_PROVIDERS,
    deployableServiceTypes: DEPLOYABLE_SERVICE_TYPES,
  };
});

app.get("/admin/llm-usage", async (request, reply) => {
  if (!requireAdmin(request, reply, env)) return;

  const since = startOfUtcDay();
  const recent = await db
    .select({
      runId: llmUsage.runId,
      projectId: llmUsage.projectId,
      provider: llmUsage.provider,
      model: llmUsage.model,
      operation: llmUsage.operation,
      inputTokens: llmUsage.inputTokens,
      outputTokens: llmUsage.outputTokens,
      estimatedCostCents: llmUsage.estimatedCostCents,
      success: llmUsage.success,
      error: llmUsage.error,
      createdAt: llmUsage.createdAt,
    })
    .from(llmUsage)
    .orderBy(desc(llmUsage.createdAt))
    .limit(50);
  const totals = await db
    .select({
      calls: sql<number>`count(*)`,
      estimatedCostCents: sql<number>`coalesce(sum(${llmUsage.estimatedCostCents}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)`,
    })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, since));
  return { today: totals[0], recent };
});

app.get("/admin/config-check", async (request, reply) => {
  if (!requireAdmin(request, reply, env)) return;
  return backendConfigCheck();
});

app.post("/admin/reconcile-stuck-runs", async (request, reply) => {
  if (!requireAdmin(request, reply, env)) return;

  const summary = await reconcileStuckRunsSafely("admin");
  if (!summary) return { ok: false };
  return { ok: true, summary };
});

/**
 * SSE stream of the run's event timeline. Dev implementation tails run_events by
 * polling on `seq`; the DB remains the single source of truth. Closes when the
 * run reaches a terminal status.
 */
app.get("/runs/:runId/events", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }

  // Take over the raw socket; we manage the SSE stream lifecycle ourselves.
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": env.WEB_ORIGIN,
  });

  let lastSeq = -1;
  let closed = false;

  const tick = async (): Promise<void> => {
    if (closed) return;
    const rows = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
      .orderBy(asc(runEvents.seq));

    for (const row of rows) {
      lastSeq = row.seq;
      reply.raw.write(`event: run_event\ndata: ${JSON.stringify(row)}\n\n`);
    }

    const [run] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) {
      // Unknown run id — tell the client and close rather than poll forever.
      reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: "not_found" })}\n\n`);
      stop();
      return;
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      stop();
      return;
    }
    if (rows.length === 0) {
      // Heartbeat so proxies/load-balancers don't drop an idle SSE connection.
      reply.raw.write(`: keepalive\n\n`);
    }
  };

  const interval = setInterval(() => void tick(), 1000);
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    reply.raw.end();
  };

  request.raw.on("close", stop);
  await tick();
});

/**
 * Run snapshot for hydration: lets the UI survive refresh and render finished
 * runs (links, per-layer status, verification) without replaying the SSE stream.
 */
app.get("/runs/:runId", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }
  const snapshot = await buildRunSnapshot(runId);
  if (!snapshot) return reply.status(404).send({ error: "run_not_found" });
  return snapshot;
});

/**
 * "My Apps": one card per connected repo (project), with its latest run's status
 * and live links. Powers the dashboard.
 */
app.get("/apps", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.createdAt));

  const apps = await Promise.all(
    projectRows.map(async (project) => {
      const projectRuns = await db
        .select()
        .from(runs)
        .where(eq(runs.projectId, project.id))
        .orderBy(desc(runs.startedAt))
        .limit(20);
      const latestRun = projectRuns[0] ?? null;

      let resources: ReturnType<typeof toSnapshotResources> = [];
      let layers = null;
      let verification: ReturnType<typeof verificationFromEvents> = [];
      let liveDeployment = null;
      if (latestRun) {
        const latest = await buildResourceSnapshotForRun(latestRun.id);
        resources = latest.resources;
        verification = latest.verification;
        layers = latest.layers;

        for (const candidate of projectRuns) {
          const snapshot = await buildResourceSnapshotForRun(candidate.id);
          const frontendLive = snapshot.resources.some(
            (r) => r.role === "frontend" && r.status === "live" && r.url,
          );
          if (candidate.status === "succeeded" || snapshot.layers.fullStack.live || frontendLive) {
            liveDeployment = {
              runId: candidate.id,
              status: candidate.status,
              resources: snapshot.resources,
              layers: snapshot.layers,
              verification: snapshot.verification,
            };
            if (candidate.id !== latestRun.id) {
              resources = snapshot.resources;
              verification = snapshot.verification;
              layers = snapshot.layers;
            }
            break;
          }
        }
      }

      return {
        projectId: project.id,
        repoFullName: project.repoFullName,
        defaultBranch: project.defaultBranch,
        latestRun: latestRun
          ? {
              id: latestRun.id,
              mode: latestRun.mode,
              status: latestRun.status,
              startedAt: latestRun.startedAt,
              finishedAt: latestRun.finishedAt,
            }
          : null,
        resources,
        layers,
        verification,
        liveDeployment,
      };
    }),
  );

  return { apps };
});

/** Per-app detail: current live resources plus full run history. */
app.get("/apps/:projectId", async (request, reply) => {
  const user = await requireAlphaUser(request, reply, db, env);
  if (!user) return;

  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .limit(1);
  if (!project) return reply.status(404).send({ error: "project_not_found" });

  const history = await db
    .select({
      id: runs.id,
      mode: runs.mode,
      status: runs.status,
      commitSha: runs.commitSha,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.startedAt));

  let current = null;
  let latestLiveDeployment = null;
  if (history[0]) {
    const latest = await buildResourceSnapshotForRun(history[0].id);
    current = {
      resources: latest.resources,
      layers: latest.layers,
      runId: history[0].id,
      verification: latest.verification,
    };

    for (const candidate of history) {
      const snapshot = await buildResourceSnapshotForRun(candidate.id);
      const frontendLive = snapshot.resources.some(
        (r) => r.role === "frontend" && r.status === "live" && r.url,
      );
      if (candidate.status === "succeeded" || snapshot.layers.fullStack.live || frontendLive) {
        latestLiveDeployment = {
          runId: candidate.id,
          status: candidate.status,
          resources: snapshot.resources,
          layers: snapshot.layers,
          verification: snapshot.verification,
        };
        break;
      }
    }
  }

  return {
    project: {
      id: project.id,
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      createdAt: project.createdAt,
    },
    current,
    latestLiveDeployment,
    history,
  };
});

// TODO: POST /runs/:id/inputs — answer PlanQuestions (signal the workflow); lands
//       with the human-in-the-loop deploy slice, not analyze_only.

const start = async (): Promise<void> => {
  try {
    await reconcileStuckRunsSafely("startup");
    setInterval(() => void reconcileStuckRunsSafely("interval"), RECONCILE_INTERVAL_MS).unref();
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
