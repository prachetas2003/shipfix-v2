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
  workerHeartbeats,
} from "@shipfix/db";
import { createSafePostgresSink, createRunLogger } from "@shipfix/observability";
import { reconcileStuckRuns } from "@shipfix/workflow";
import { preflightProviderCredentials } from "@shipfix/adapter-core";
import { createSecretVaultFromEnv } from "@shipfix/secrets";
import { env, shipfixEnvLoad } from "./env";
import { requireAdmin, requireUser, type AuthenticatedUser } from "./auth";
import { alphaDefaultsProfile, usageLimitMessage } from "./alphaLimits";
import { apiControlPlaneDiagnostics } from "./configCheck";
import { assertRunPersisted } from "./runLifecycle";
import {
  logWorkflowStarted,
  logWorkflowStarting,
  markWorkflowStartFailed,
  withTimeout,
  type WorkflowStartInfo,
} from "./workflowStart";
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

app.setErrorHandler((err, _request, reply) => {
  if ((err as { code?: string }).code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
    void reply.status(400).send({
      error: "empty_json_body",
      message: "Could not start deploy from plan. Please retry.",
    });
    return;
  }
  void reply.send(err);
});

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

async function refreshTemporalStatus(reason: string): Promise<typeof temporalStatus> {
  try {
    await withTimeout(
      Connection.connect({ address: env.TEMPORAL_ADDRESS }),
      TEMPORAL_CHECK_TIMEOUT_MS,
      `Temporal connectivity check timed out after ${TEMPORAL_CHECK_TIMEOUT_MS}ms`,
    );
    temporalStatus = { reachable: true, checkedAt: new Date().toISOString(), error: null };
  } catch (err) {
    temporalStatus = {
      reachable: false,
      checkedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
    app.log.warn({ reason, temporalStatus }, "Temporal connectivity check failed");
  }
  return temporalStatus;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "diagnosed"]);
const RECONCILE_INTERVAL_MS = 15 * 1000;
const TEMPORAL_CHECK_INTERVAL_MS = 60 * 1000;
const TEMPORAL_CHECK_TIMEOUT_MS = 2_500;
const WORKFLOW_START_TIMEOUT_MS = 10_000;
const NON_TERMINAL_STATUSES = ["queued", "analyzing", "planning", "validating", "awaiting_input", "provisioning", "deploying", "verifying"];
const ipStarts = new Map<string, number[]>();

let temporalStatus: { reachable: boolean; checkedAt: string | null; error: string | null } = {
  reachable: false,
  checkedAt: null,
  error: "not_checked",
};

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
  return normalizePlanForResponse(row?.doc) as PlanLite | null;
}

function normalizePlanForResponse(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return null;
  const plan = structuredClone(doc) as {
    services?: Array<{ id: string; env?: Array<{ name: string; source: string; ref?: string }> }>;
    wiring?: Array<{ fromServiceId: string; fromField: string; toServiceId: string; toEnvName: string }>;
    blockers?: Array<{ title?: string; explanation?: string }>;
  };
  plan.wiring ??= [];
  const key = (w: { fromServiceId: string; fromField: string; toServiceId: string; toEnvName: string }) =>
    `${w.fromServiceId}.${w.fromField}->${w.toServiceId}.${w.toEnvName}`;
  const existing = new Set(plan.wiring.map(key));
  for (const service of plan.services ?? []) {
    for (const envVar of service.env ?? []) {
      if (envVar.source !== "generated_from_service" && envVar.source !== "generated_from_managed") continue;
      const [fromServiceId, fromField] = (envVar.ref ?? "").split(".");
      if (!fromServiceId || !fromField) continue;
      if (envVar.source === "generated_from_service" && fromField !== "publicUrl" && fromField !== "origin") continue;
      if (envVar.source === "generated_from_managed" && fromField !== "connectionUrl") continue;
      const edge = { fromServiceId, fromField, toServiceId: service.id, toEnvName: envVar.name };
      if (!existing.has(key(edge))) {
        plan.wiring.push(edge);
        existing.add(key(edge));
      }
    }
  }
  plan.blockers = (plan.blockers ?? []).filter(
    (b) => b.title !== "Generated env var has no wiring edge" && !/has no matching wiring edge/i.test(b.explanation ?? ""),
  );
  return plan;
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

async function latestWorkerHeartbeat() {
  try {
    const [row] = await db
      .select({
        lastSeenAt: workerHeartbeats.lastSeenAt,
        taskQueue: workerHeartbeats.taskQueue,
        temporalAddress: workerHeartbeats.temporalAddress,
        temporalNamespace: workerHeartbeats.temporalNamespace,
        status: workerHeartbeats.status,
      })
      .from(workerHeartbeats)
      .orderBy(desc(workerHeartbeats.lastSeenAt))
      .limit(1);
    return row ?? null;
  } catch (err) {
    app.log.warn({ err }, "worker heartbeat diagnostics unavailable");
    return null;
  }
}

async function backendConfigCheck() {
  const provider = process.env.LLM_PROVIDER ?? "";
  const providerKey =
    provider.trim().toLowerCase() === "openai"
      ? "OPENAI_API_KEY"
      : provider.trim().toLowerCase() === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider.trim().toLowerCase() === "gemini"
          ? "GEMINI_API_KEY"
          : null;
  const providerKeyConfigured = providerKey ? Boolean(process.env[providerKey]?.trim()) : false;
  const legacyLlmKeyConfigured = Boolean(process.env.LLM_API_KEY?.trim());
  const controlPlane = apiControlPlaneDiagnostics(
    env,
    shipfixEnvLoad,
    await latestWorkerHeartbeat(),
    temporalStatus,
  );
  return {
    databaseUrl: controlPlane.databaseUrlPresent,
    ...controlPlane,
    authMode: env.AUTH_MODE,
    clerkSecretConfigured: Boolean(env.CLERK_SECRET_KEY),
    adminTokenConfigured: Boolean(env.SHIPFIX_ADMIN_TOKEN),
    masterKeyConfigured: Boolean(env.SHIPFIX_MASTER_KEY),
    llmProvider: provider || null,
    llmProviderAccepted: ["openai", "anthropic", "gemini"].includes(provider.trim().toLowerCase()),
    llmModelConfigured: Boolean(process.env.LLM_MODEL?.trim()),
    llmProviderKeyConfigured: providerKeyConfigured,
    llmLegacyApiKeyConfigured: legacyLlmKeyConfigured,
    llmProviderKeyOrLegacyConfigured: providerKeyConfigured || legacyLlmKeyConfigured,
    llmExpectedKeyEnv: providerKey,
    llmMaxPromptChars: Number(process.env.LLM_MAX_PROMPT_CHARS || (process.env.NODE_ENV === "production" ? 60_000 : 120_000)),
    neonOrgIdConfigured: neonOrgIdConfigured(),
    neonOrgIdEnvConfigured: Boolean(process.env.NEON_ORG_ID?.trim()),
    neonOrganizationIdEnvConfigured: Boolean(process.env.NEON_ORGANIZATION_ID?.trim()),
    limits: {
      defaultsProfile: alphaDefaultsProfile(),
      deployRunsPerUserPerDay: env.ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY,
      planAnalyzeRunsPerUserPerDay: env.ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY,
      activeDeployRunsPerUser: env.ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER,
      llmCallsPerRun: env.ALPHA_MAX_LLM_CALLS_PER_RUN,
      llmCallsPerUserPerDay: env.ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY,
      ipWindowMs: env.ALPHA_RATE_LIMIT_WINDOW_MS,
      maxRunStartsPerIpWindow: env.ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW,
    },
    localWorkerEnv: {
      note: "Plan/deploy work runs in the worker. Restart pnpm dev:worker after changing root .env or apps/worker/.env.local.",
      readsRootEnv: true,
      readsWorkerEnvLocal: true,
      envSourcePath: shipfixEnvLoad.envSourcePath,
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
  vercel: ["frontend_static", "frontend_ssr"],
};

function neonOrgIdConfigured(): boolean {
  return Boolean(process.env.NEON_ORG_ID?.trim() || process.env.NEON_ORGANIZATION_ID?.trim());
}

function providerReadyForRuntime(provider: string): boolean {
  if (provider === "neon") return neonOrgIdConfigured();
  return true;
}

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
    const unit = mode === "deploy" ? "deploy runs per user per day" : "plan/analyze runs per user per day";
    return {
      ok: false,
      code: "daily_run_limit",
      message: usageLimitMessage({ code: "daily_run_limit", limit: dailyLimit, unit, nodeEnv: process.env.NODE_ENV }),
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
        code: "active_deploy_limit",
        message: usageLimitMessage({
          code: "active_deploy_limit",
          limit: env.ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER,
          unit: "active deploy runs per user",
          nodeEnv: process.env.NODE_ENV,
        }),
      };
    }
  }

  return { ok: true };
}

async function startTemporalWorkflowForRun(
  runId: string,
  mode: RunMode,
  logger: ReturnType<typeof createRunLogger>,
): Promise<StartResult> {
  const workflowId = `run-${runId}`;
  const info: WorkflowStartInfo = {
    workflowId,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    temporalAddress: env.TEMPORAL_ADDRESS,
    temporalNamespace: env.TEMPORAL_NAMESPACE,
  };

  await logWorkflowStarting(logger, info);

  try {
    const client = await withTimeout(
      temporal(),
      WORKFLOW_START_TIMEOUT_MS,
      `Temporal is not reachable at ${env.TEMPORAL_ADDRESS}. Start Temporal and retry.`,
    );
    await withTimeout(
      client.workflow.start("deploymentWorkflow", {
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId,
        args: [{ runId, mode }],
      }),
      WORKFLOW_START_TIMEOUT_MS,
      `Temporal did not accept workflow start within ${WORKFLOW_START_TIMEOUT_MS}ms.`,
    );
    await db.update(runs).set({ temporalId: workflowId }).where(eq(runs.id, runId));
    temporalStatus = { reachable: true, checkedAt: new Date().toISOString(), error: null };
    await logWorkflowStarted(logger, info);
    return { ok: true, runId };
  } catch (startErr) {
    await markWorkflowStartFailed(db, logger, runId, info, startErr);
    temporalStatus = {
      reachable: false,
      checkedAt: new Date().toISOString(),
      error: startErr instanceof Error ? startErr.message : String(startErr),
    };
    return {
      ok: false,
      runId,
      code: "internal_workflow_start_failed",
      message:
        "ShipFix created the run, but could not start the Temporal workflow. Start Temporal and the worker, then retry.",
    };
  }
}

/**
 * Create a run, seed its timeline, and start the Temporal workflow. Shared by
 * the analyze and plan routes — the only difference is `mode`. On a workflow
 * start failure the run is marked `failed` (never left orphaned in `queued`).
 */
async function startRun(
  mode: RunMode,
  user: AuthenticatedUser,
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
  const logger = createRunLogger(run.id, createSafePostgresSink(db));
  await logger.stage("queued", `Run queued for ${input.repoFullName}`);
  await assertRunPersisted(db, run.id);
  return startTemporalWorkflowForRun(run.id, mode, logger);
}

async function startDeployFromExistingRun(
  user: AuthenticatedUser,
  sourceRunId: string,
): Promise<StartResult> {
  const [source] = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      commitSha: runs.commitSha,
      mode: runs.mode,
      status: runs.status,
      repoFullName: projects.repoFullName,
      defaultBranch: projects.defaultBranch,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, sourceRunId), eq(projects.userId, user.id)))
    .limit(1);
  if (!source) {
    return { ok: false, runId: "", code: "run_not_found", message: "Run not found." };
  }

  const [sourcePlan] = await db
    .select()
    .from(plans)
    .where(eq(plans.runId, sourceRunId))
    .orderBy(desc(plans.version))
    .limit(1);
  if (!sourcePlan) {
    return {
      ok: false,
      runId: "",
      code: "plan_not_found",
      message: "No validated plan was found for this run. Re-check the plan before deploying.",
    };
  }

  const limits = await checkRunLimits(user.id, source.projectId, "deploy");
  if (!limits.ok) {
    return { ok: false, runId: "", code: limits.code, message: limits.message };
  }

  const [run] = await db
    .insert(runs)
    .values({
      projectId: source.projectId,
      commitSha: source.commitSha,
      trigger: "retry",
      mode: "deploy",
      status: "queued",
    })
    .returning();

  const [copiedPlan] = await db
    .insert(plans)
    .values({
      runId: run.id,
      version: 1,
      doc: normalizePlanForResponse(sourcePlan.doc),
      planner: sourcePlan.planner,
      confidence: sourcePlan.confidence,
    })
    .returning();
  await db.update(runs).set({ planId: copiedPlan.id }).where(eq(runs.id, run.id));

  const logger = createRunLogger(run.id, createSafePostgresSink(db));
  await logger.stage("queued", `Deploy queued for ${source.repoFullName}`);
  await logger.log("Deploy will use the selected validated plan", {
    event: "deploy_from_plan",
    sourceRunId,
    sourcePlanId: sourcePlan.id,
  });
  await assertRunPersisted(db, run.id);
  return startTemporalWorkflowForRun(run.id, "deploy", logger);
}

/** Build a Fastify handler that launches a run in the given mode. */
function runRouteHandler(mode: RunMode) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(request, reply, db, env);
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
        error: "ip_run_start_limit",
        message: usageLimitMessage({
          code: "ip_run_start_limit",
          limit: env.ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW,
          unit: `run starts per ${env.ALPHA_RATE_LIMIT_WINDOW_MS}ms IP window`,
          nodeEnv: process.env.NODE_ENV,
        }),
      });
    }

    try {
      const result = await startRun(mode, user, {
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
      // Log the real error server-side; never leak internals to the client.
      request.log.error(err);
      return reply.status(500).send({
        error: "internal",
        message: "ShipFix hit an internal error starting this run. Try again in a minute.",
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

app.post("/runs/:runId/deploy", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!checkIpRateLimit(request.ip)) {
    await recordRateLimitRejection({ userId: user.id, operation: "deploy", code: "ip_run_start_limit" });
    return reply.status(429).send({
      error: "ip_run_start_limit",
      message: usageLimitMessage({
        code: "ip_run_start_limit",
        limit: env.ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW,
        unit: `run starts per ${env.ALPHA_RATE_LIMIT_WINDOW_MS}ms IP window`,
        nodeEnv: process.env.NODE_ENV,
      }),
    });
  }

  const result = await startDeployFromExistingRun(user, runId);
  if (!result.ok) {
    const status =
      result.code === "run_not_found"
        ? 404
        : result.code === "plan_not_found"
          ? 400
          : result.runId
            ? 503
            : 429;
    return reply.status(status).send({ runId: result.runId || undefined, error: result.code, message: result.message });
  }
  return reply.status(202).send({ runId: result.runId, mode: "deploy" });
});

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
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const parsed = ConnectBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }

  let vault: ReturnType<typeof createSecretVaultFromEnv>;
  try {
    vault = createSecretVaultFromEnv();
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({
      error: "vault_unconfigured",
      message: "ShipFix's secret storage is not configured on the server, so credentials cannot be saved yet.",
    });
  }

  // Prove the token is accepted by the provider BEFORE sealing it, so a bad
  // key fails here in seconds instead of mid-deploy. Provider outages do not
  // block (preflight only rejects on a definite 401/403).
  const preflight = await preflightProviderCredentials(parsed.data.provider, parsed.data.values);
  if (!preflight.ok) {
    return reply.status(422).send({
      error: "credential_rejected",
      message: preflight.message ?? "The provider rejected this credential.",
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
    return reply.status(500).send({
      error: "internal",
      message: "ShipFix hit an internal error saving this connection. Try again in a minute.",
    });
  }
});

// What ShipFix can actually do right now, plus what this user has connected.
app.get("/providers", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const accounts = await db
    .select({ provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, user.id));
  return {
    connected: accounts.map((a) => a.provider).filter(providerReadyForRuntime),
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

app.post("/admin/runs/reconcile-stuck", async (request, reply) => {
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
  const user = await requireUser(request, reply, db, env);
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
  const user = await requireUser(request, reply, db, env);
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
  const user = await requireUser(request, reply, db, env);
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
  const user = await requireUser(request, reply, db, env);
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
  let deployAction = null;
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

    const actionCandidates = [
      ...history.filter((r) => r.mode === "deploy" && (r.status === "failed" || r.status === "diagnosed")),
      ...history.filter((r) => r.mode === "plan" && r.status === "succeeded"),
    ];
    for (const actionSource of actionCandidates) {
      const [actionPlan] = await db
        .select({ doc: plans.doc })
        .from(plans)
        .where(eq(plans.runId, actionSource.id))
        .orderBy(desc(plans.version))
        .limit(1);
      if (actionPlan) {
        deployAction = {
          sourceRunId: actionSource.id,
          label: actionSource.mode === "plan" ? "Deploy from latest plan" : "Retry deploy",
          plan: normalizePlanForResponse(actionPlan.doc),
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
    deployAction,
    history,
  };
});

// TODO: POST /runs/:id/inputs — answer PlanQuestions (signal the workflow); lands
//       with the human-in-the-loop deploy slice, not analyze_only.

const start = async (): Promise<void> => {
  try {
    await refreshTemporalStatus("startup");
    setInterval(() => void refreshTemporalStatus("interval"), TEMPORAL_CHECK_INTERVAL_MS).unref();
    await reconcileStuckRunsSafely("startup");
    setInterval(() => void reconcileStuckRunsSafely("interval"), RECONCILE_INTERVAL_MS).unref();
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
