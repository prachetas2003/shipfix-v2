import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import {
  createDb,
  deployedResources,
  plans,
  projects,
  providerAccounts,
  llmUsage,
  runEvents,
  runInputs,
  projectEnvVars,
  runs,
  workerHeartbeats,
  githubInstallations,
  ownedGithubInstallationIds,
} from "@shipfix/db";
import { createSafePostgresSink, createRunLogger } from "@shipfix/observability";
import { checkoutForm, guardianEntitled, PLAN_OFFERS, subscriptionFromEvent, verifyStripeSignature, type SubscriptionUpdate } from "@shipfix/billing";
import { incidentText, notifySlack, probeHealth, rollbackCommit, runCostCents, summarizeCheck, ONE_ENVIRONMENT_NOTE, attachHostname, backupTarget, deleteProviderResource, domainTarget, planTeardown, validHostname, type OwnedResource, type ProbeTarget } from "@shipfix/guardian";
import { NEON_BACKUP_PREFIX, createSupabaseRestorePoint, restoreNeonBranch, snapshotNeonDatabase } from "@shipfix/provisioner";
import { readGuardianBills } from "./guardianBills";
import { INPUTS_SUBMITTED_SIGNAL, reconcileStuckRuns, revalidatePlanForRun, type WorkflowLiveness } from "@shipfix/workflow";
import {
  allowedOauthRedirect,
  authorizeUrl,
  createPkce,
  exchangeOauthCode,
  loadOauthApp,
  loadOauthApps,
  peekOauthProvider,
  preflightProviderCredentials,
  signOauthState,
  verifyOauthState,
} from "@shipfix/adapter-core";
import { createSecretVaultFromEnv } from "@shipfix/secrets";
import {
  createInstallationAccessToken,
  exchangeGithubUserCode,
  githubAppInstallUrl,
  listGithubUserInstallations,
  listInstallationRepositories,
  loadGithubAppConfigFromEnv,
  resolveCloneToken,
  resolveGithubBranchSha,
  resolveGithubDefaultBranch,
  shouldAutoDeployPush,
  verifyGithubWebhookSignature,
  type GithubPushEvent,
} from "@shipfix/github";
import { env, shipfixEnvLoad } from "./env";
import { requireAdmin, requireStreamUser, requireUser, type AuthenticatedUser } from "./auth";
import { issueStreamTicket, streamTicketKey, verifyStreamTicket } from "./streamTicket";
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
  diagnosesFromEvents,
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
const streamKey = streamTicketKey([env.SHIPFIX_MASTER_KEY, env.CLERK_SECRET_KEY, env.SHIPFIX_ADMIN_TOKEN]);

/** GitHub webhooks need the raw body for HMAC verification (encapsulated parser). */
await app.register(async (githubHooks) => {
  githubHooks.removeContentTypeParser("application/json");
  githubHooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  githubHooks.post("/webhooks/github", async (request, reply) => {
    const config = loadGithubAppConfigFromEnv();
    const secret = config?.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return reply.status(503).send({
        error: "webhook_unconfigured",
        message: "GITHUB_WEBHOOK_SECRET is not set.",
      });
    }

    const rawBody = request.body as Buffer;
    const signature = request.headers["x-hub-signature-256"];
    const sigHeader = Array.isArray(signature) ? signature[0] : signature;
    if (!verifyGithubWebhookSignature(rawBody, sigHeader, secret)) {
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const eventName = request.headers["x-github-event"];
    const name = Array.isArray(eventName) ? eventName[0] : eventName;
    if (name === "ping") {
      return reply.status(200).send({ ok: true });
    }
    if (name !== "push") {
      return reply.status(200).send({ ok: true, ignored: true });
    }

    let event: GithubPushEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as GithubPushEvent;
    } catch {
      return reply.status(400).send({ error: "invalid_json" });
    }

    const repoFullName = event.repository?.full_name?.trim();
    if (!repoFullName) {
      return reply.status(200).send({ ok: true, ignored: true, reason: "missing_repo" });
    }

    const candidates = await db
      .select()
      .from(projects)
      .where(and(eq(projects.repoFullName, repoFullName), eq(projects.autoDeployOnPush, true)));

    if (candidates.length === 0) {
      return reply.status(200).send({ ok: true, ignored: true, reason: "no_auto_deploy_projects" });
    }

    const started: string[] = [];
    const skipped: Array<{ projectId: string; reason: string }> = [];

    for (const project of candidates) {
      const gate = shouldAutoDeployPush(event, project.defaultBranch);
      if (!gate.ok) {
        skipped.push({ projectId: project.id, reason: gate.reason });
        continue;
      }

      // A push only deploys projects whose owner has claimed the installation that
      // sent it; otherwise anyone could register a project for someone else's repo.
      const owned = gate.installationId
        ? (await ownedGithubInstallationIds(db, project.userId)).includes(gate.installationId)
        : false;
      if (!owned) {
        skipped.push({ projectId: project.id, reason: "installation_not_owned" });
        continue;
      }
      if (gate.installationId !== project.githubInstallationId) {
        await db
          .update(projects)
          .set({ githubInstallationId: gate.installationId })
          .where(eq(projects.id, project.id));
      }

      const limits = await checkRunLimits(project.userId, project.id, "deploy");
      if (!limits.ok) {
        skipped.push({ projectId: project.id, reason: limits.code });
        continue;
      }

      const [run] = await db
        .insert(runs)
        .values({
          projectId: project.id,
          commitSha: gate.commitSha,
          trigger: "push",
          mode: "deploy",
          status: "queued",
        })
        .returning();

      const logger = createRunLogger(run.id, createSafePostgresSink(db));
      await logger.stage("queued", `Push deploy queued for ${repoFullName}@${gate.commitSha.slice(0, 8)}`);
      await assertRunPersisted(db, run.id);
      const result = await startTemporalWorkflowForRun(run.id, "deploy", logger);
      if (result.ok) started.push(run.id);
      else skipped.push({ projectId: project.id, reason: result.code });
    }

    return reply.status(202).send({ ok: true, started, skipped });
  });
});


await app.register(async (stripeHooks) => {
  stripeHooks.removeContentTypeParser("application/json");
  stripeHooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  stripeHooks.post("/webhooks/stripe", async (request, reply) => {
    const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) return reply.status(503).send({ error: "webhook_unconfigured" });
    const raw = request.body as Buffer;
    const header = request.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifyStripeSignature(raw.toString("utf8"), signature, secret)) {
      return reply.status(401).send({ error: "invalid_signature" });
    }
    let event: unknown;
    try {
      event = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return reply.status(400).send({ error: "invalid_body" });
    }
    const update = subscriptionFromEvent(event);
    if (update) await applySubscription(update);
    return { ok: true };
  });
});

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
/** Resume a deploy that is paused on a question. A finished or missing workflow is not an error. */
async function signalInputWait(runId: string): Promise<void> {
  const [run] = await db
    .select({ status: runs.status, temporalId: runs.temporalId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (run?.status !== "awaiting_input" || !run.temporalId) return;
  try {
    const client = await temporal();
    await client.workflow.getHandle(run.temporalId).signal(INPUTS_SUBMITTED_SIGNAL);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return;
    throw err;
  }
}

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
const NON_TERMINAL_STATUSES = ["queued", "analyzing", "planning", "validating", "awaiting_input", "provisioning", "deploying", "wiring", "verifying"];
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
  if (existing[0]) {
    if (existing[0].defaultBranch !== defaultBranch) {
      await db.update(projects).set({ defaultBranch }).where(eq(projects.id, existing[0].id));
    }
    return existing[0];
  }
  const [created] = await db
    .insert(projects)
    .values({ userId, repoFullName, defaultBranch })
    .returning();
  return created;
}

/** Clone token for a repo, minted only through installations this user has claimed. */
async function cloneTokenForUser(
  userId: string,
  repoFullName: string,
  installationId?: string | null,
): Promise<string> {
  return resolveCloneToken({
    repoFullName,
    installationId,
    allowedInstallationIds: await ownedGithubInstallationIds(db, userId),
  });
}

/**
 * Branch to build: the caller's explicit branch, else the repo's real default
 * branch from GitHub. Falls back to the stored project branch (or "main") only
 * when GitHub is unreachable, never when the repo is missing.
 */
async function resolveRunBranch(
  userId: string,
  repoFullName: string,
  explicit: string | undefined,
): Promise<{ ok: true; branch: string } | { ok: false; error: string; message: string }> {
  if (explicit?.trim()) return { ok: true, branch: explicit.trim() };
  const token = await cloneTokenForUser(userId, repoFullName);
  const looked = await resolveGithubDefaultBranch(repoFullName, { token: token || null });
  if ("branch" in looked) return { ok: true, branch: looked.branch };
  if (looked.error === "repo_not_found") return { ok: false, error: looked.error, message: looked.message };
  const [existing] = await db
    .select({ defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.repoFullName, repoFullName)))
    .limit(1);
  return { ok: true, branch: existing?.defaultBranch ?? "main" };
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
  const rows = await db
    .select({
      serviceId: deployedResources.serviceId,
      kind: deployedResources.kind,
      provider: deployedResources.provider,
      externalId: deployedResources.externalId,
      url: deployedResources.url,
      status: deployedResources.status,
      exposesEnv: deployedResources.exposesEnv,
      createdAt: deployedResources.createdAt,
      meta: deployedResources.meta,
    })
    .from(deployedResources)
    .where(eq(deployedResources.runId, runId));
  return rows.map((r) => ({
    ...r,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  }));
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

  const [plan, resourceRows, events, inputRows] = await Promise.all([
    loadPlanDoc(runId),
    loadResourceRows(runId),
    db
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq)),
    db
      .select({ questionId: runInputs.questionId })
      .from(runInputs)
      .where(eq(runInputs.runId, runId)),
  ]);

  const resources = toSnapshotResources(resourceRows, plan);
  const verification = verificationFromEvents(events);
  const diagnoses = diagnosesFromEvents(events);
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
    diagnoses,
    layers,
    // Question ids only — never secret values.
    answeredQuestionIds: inputRows.map((r) => r.questionId),
  };
}

async function workflowLiveness(runId: string): Promise<WorkflowLiveness> {
  try {
    const client = await withTimeout(temporal(), 3000, "Temporal connect timed out");
    const description = await withTimeout(
      client.workflow.getHandle(`run-${runId}`).describe(),
      3000,
      "Temporal describe timed out",
    );
    return description.status.name === "RUNNING" ? "running" : "closed";
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return "not_found";
    return "unknown";
  }
}

async function reconcileStuckRunsSafely(reason: string) {
  try {
    const summary = await reconcileStuckRuns(db, { workflowLiveness });
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
const PROVISIONABLE_PROVIDERS = ["neon", "upstash"] as const;
const DEPLOYABLE_PROVIDERS = ["render", "vercel"] as const;
const DEPLOYABLE_SERVICE_TYPES: Record<string, string[]> = {
  render: ["node_api", "python_api", "docker_service", "worker"],
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
  input: { repoFullName: string; branch: string; commitSha: string; trigger?: "manual" | "push" },
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
      trigger: input.trigger ?? "manual",
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

  // C2: revalidate with answered secrets before copying — may flip Yellow → Green.
  try {
    await revalidatePlanForRun(db, sourceRunId);
  } catch {
    /* keep source plan if revalidate cannot run (e.g. missing analysis) */
  }

  const [freshPlan] = await db
    .select()
    .from(plans)
    .where(eq(plans.runId, sourceRunId))
    .orderBy(desc(plans.version))
    .limit(1);
  const planToCopy = freshPlan ?? sourcePlan;

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
      doc: normalizePlanForResponse(planToCopy.doc),
      planner: planToCopy.planner,
      confidence: planToCopy.confidence,
    })
    .returning();
  await db.update(runs).set({ planId: copiedPlan.id }).where(eq(runs.id, run.id));

  // Carry answered plan questions onto the deploy run (sealed blobs copied as-is).
  const sourceInputs = await db.select().from(runInputs).where(eq(runInputs.runId, sourceRunId));
  if (sourceInputs.length > 0) {
    await db.insert(runInputs).values(
      sourceInputs.map((row) => ({
        runId: run.id,
        questionId: row.questionId,
        isSecret: row.isSecret,
        valuePlain: row.valuePlain,
        encBlob: row.encBlob,
        encIv: row.encIv,
        encDek: row.encDek,
      })),
    );
  }

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
      const branch = await resolveRunBranch(user.id, repoFullName, parsed.data.branch);
      if (!branch.ok) {
        return reply.status(400).send({ error: branch.error, message: branch.message });
      }
      const result = await startRun(mode, user, {
        repoFullName,
        branch: branch.branch,
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

/**
 * Redeploy latest tip of the project's default branch (re-analyze + plan + deploy).
 * Same-SHA plan retry remains available via POST /runs/:runId/deploy.
 */
app.post("/apps/:projectId/redeploy", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
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

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .limit(1);
  if (!project) return reply.status(404).send({ error: "project_not_found" });

  const token = await cloneTokenForUser(user.id, project.repoFullName, project.githubInstallationId);
  const branchLookup = await resolveGithubDefaultBranch(project.repoFullName, { token: token || null });
  const branch = "branch" in branchLookup ? branchLookup.branch : project.defaultBranch;
  const resolved = await resolveGithubBranchSha(project.repoFullName, branch, {
    token: token || null,
  });
  if ("error" in resolved) {
    return reply.status(502).send({ error: resolved.error, message: resolved.message });
  }

  try {
    const result = await startRun("deploy", user, {
      repoFullName: project.repoFullName,
      branch,
      commitSha: resolved.sha,
    });
    if (!result.ok) {
      if (!result.runId) {
        return reply.status(429).send({ error: result.code, message: result.message });
      }
      return reply.status(503).send({ runId: result.runId, error: result.code, message: result.message });
    }
    return reply.status(202).send({
      runId: result.runId,
      mode: "deploy",
      commitSha: resolved.sha,
      branch,
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "internal",
      message: "ShipFix hit an internal error starting this redeploy. Try again in a minute.",
    });
  }
});

async function guardianLive(userId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return null;
  const history = await db
    .select({
      id: runs.id,
      status: runs.status,
      commitSha: runs.commitSha,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.startedAt));
  let live: { runId: string; commitSha: string; resources: Awaited<ReturnType<typeof buildResourceSnapshotForRun>>["resources"] } | null = null;
  for (const candidate of history) {
    const snapshot = await buildResourceSnapshotForRun(candidate.id);
    const httpLive = snapshot.resources.some((resource) => resource.url && /^https?:\/\//i.test(resource.url));
    if (candidate.status === "succeeded" || httpLive) {
      live = { runId: candidate.id, commitSha: candidate.commitSha, resources: snapshot.resources };
      break;
    }
  }
  const plan = live ? await loadPlanDoc(live.runId) : null;
  return { project, history, live, plan };
}

/** Probe the live URLs. A Slack webhook in GUARDIAN_SLACK_WEBHOOK is notified when something is down. */
app.post("/apps/:projectId/guardian/check", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const healthByService = new Map((found.plan?.services ?? []).map((service) => [service.id, service.healthCheckPath ?? null]));
  const targets: ProbeTarget[] = (found.live?.resources ?? [])
    .filter((resource) => resource.url && /^https?:\/\//i.test(resource.url) && resource.kind === "service")
    .map((resource) => ({
      serviceId: resource.serviceId,
      url: resource.url as string,
      healthPath: healthByService.get(resource.serviceId) ?? null,
    }));
  const results = await probeHealth(targets, fetch);
  const check = summarizeCheck(results);
  if (found.live) {
    const logger = createRunLogger(found.live.runId, createSafePostgresSink(db));
    await logger.log(check.lines.join("\n"), { event: check.ok ? "guardian_up" : "guardian_incident", results: check.results });
  }
  const webhook = process.env.GUARDIAN_SLACK_WEBHOOK?.trim();
  let alertSent = false;
  if (webhook && !check.ok) {
    alertSent = await notifySlack(webhook, incidentText(found.project.repoFullName, check), fetch);
  }
  return { ok: check.ok, lines: check.lines, results: check.results, alertSent };
});

/** Deploy the previous succeeded commit. The current live commit stays in history. */
app.post("/apps/:projectId/guardian/rollback", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  if (!checkIpRateLimit(request.ip)) {
    return reply.status(429).send({ error: "ip_run_start_limit", message: "Too many deploys from this network. Try again shortly." });
  }
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const currentSha = found.live?.commitSha ?? "";
  const sha = rollbackCommit(found.history, currentSha);
  if (!sha) {
    return reply.status(409).send({
      error: "no_rollback_target",
      message: "There is no earlier succeeded deploy to roll back to.",
    });
  }
  try {
    const result = await startRun("deploy", user, {
      repoFullName: found.project.repoFullName,
      branch: found.project.defaultBranch,
      commitSha: sha,
    });
    if (!result.ok) {
      const status = result.runId ? 503 : 429;
      return reply.status(status).send({ runId: result.runId || undefined, error: result.code, message: result.message });
    }
    return reply.status(202).send({ runId: result.runId, commitSha: sha, branch: found.project.defaultBranch });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "internal",
      message: "ShipFix hit an internal error starting this rollback. Try again in a minute.",
    });
  }
});

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Opens a saved provider connection. The values are never logged. */
async function openProviderValues(userId: string, provider: string): Promise<Record<string, string> | null> {
  const [account] = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
    .limit(1);
  if (!account) return null;
  try {
    const vault = createSecretVaultFromEnv();
    const raw = await vault.open({ encDek: account.encDek, encBlob: account.encBlob, encIv: account.encIv });
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") values[key] = value;
    }
    return values;
  } catch {
    return null;
  }
}

const SpendCapBody = z.object({
  capCents: z.number().int().min(0).max(10_000_000).nullable(),
});

/** Saves the app's spend cap. Null clears it. */
app.post("/apps/:projectId/guardian/cap", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  const parsed = SpendCapBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", message: "Enter a cap in cents, or clear it." });
  }
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const [project] = await db
    .update(projects)
    .set({ spendCapCents: parsed.data.capCents })
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .returning({ spendCapCents: projects.spendCapCents });
  if (!project) return reply.status(404).send({ error: "project_not_found" });
  return { capCents: project.spendCapCents };
});

/**
 * Reads this month's model cost, a Vercel account bill when the token can, and
 * Render bandwidth for this app's services. Other hosts are named and not priced.
 */
app.post("/apps/:projectId/guardian/bills", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const usage = await db
    .select({
      runId: llmUsage.runId,
      total: sql<number>`coalesce(sum(${llmUsage.estimatedCostCents}), 0)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.projectId, projectId))
    .groupBy(llmUsage.runId);
  for (const row of usage) {
    if (!row.runId) continue;
    await db.update(runs).set({ costCents: runCostCents([Number(row.total)]) }).where(eq(runs.id, row.runId));
  }
  const month = await db
    .select({ costCents: runs.costCents })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), gte(runs.startedAt, startOfUtcMonth())));
  const shipfixCents = month.reduce((sum, row) => sum + (row.costCents ?? 0), 0);

  const accounts = await db
    .select({ provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, user.id));
  const connected = accounts.map((account) => account.provider);
  const vercelValues = connected.includes("vercel") ? await openProviderValues(user.id, "vercel") : null;
  const renderValues = connected.includes("render") ? await openProviderValues(user.id, "render") : null;
  const serviceIds = (found.live?.resources ?? [])
    .filter((resource) => resource.provider === "render" && resource.externalId?.startsWith("srv-"))
    .map((resource) => resource.externalId as string);

  const report = await readGuardianBills({
    shipfixCents,
    capCents: found.project.spendCapCents ?? null,
    connected,
    vercel: vercelValues?.apiToken ? { token: vercelValues.apiToken, teamId: vercelValues.teamId || undefined } : null,
    render: renderValues?.apiKey ? { token: renderValues.apiKey, serviceIds } : null,
    vercelBlocked: connected.includes("vercel") && !vercelValues?.apiToken ? "Vercel is connected, but ShipFix could not open that credential." : null,
    renderBlocked: connected.includes("render") && !renderValues?.apiKey ? "Render is connected, but ShipFix could not open that credential." : null,
    services: (found.plan?.services ?? [])
      .filter((service) => service.provider)
      .map((service) => ({ id: service.id, type: service.type, provider: service.provider as string })),
  });

  let alertSent = false;
  const webhook = process.env.GUARDIAN_SLACK_WEBHOOK?.trim();
  if (webhook && (report.over || report.spike)) {
    alertSent = await notifySlack(webhook, report.alertText(found.project.repoFullName), fetch);
  }
  return {
    lines: report.lines,
    spike: report.spike,
    over: report.over,
    capCents: report.capCents,
    spentCents: report.spentCents,
    remainingCents: report.remainingCents,
    alertSent,
  };
});

async function liveOwnedResources(projectId: string): Promise<Array<OwnedResource & { ids: string[] }>> {
  const projectRuns = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, projectId));
  if (projectRuns.length === 0) return [];
  const rows = await db
    .select({
      id: deployedResources.id,
      provider: deployedResources.provider,
      externalId: deployedResources.externalId,
      kind: deployedResources.kind,
      serviceId: deployedResources.serviceId,
    })
    .from(deployedResources)
    .where(and(inArray(deployedResources.runId, projectRuns.map((run) => run.id)), eq(deployedResources.status, "live")));
  const grouped = new Map<string, OwnedResource & { ids: string[] }>();
  for (const row of rows) {
    if (!row.externalId) continue;
    const key = `${row.provider}:${row.externalId}`;
    const existing = grouped.get(key);
    if (existing) existing.ids.push(row.id);
    else grouped.set(key, { provider: row.provider, externalId: row.externalId, kind: row.kind, serviceId: row.serviceId, ids: [row.id] });
  }
  return [...grouped.values()];
}

const ConfirmBody = z.object({ confirm: z.string().min(1).max(200) });
const DomainBody = z.object({ hostname: z.string().min(1).max(253) });
const RestoreBody = ConfirmBody.extend({ branchName: z.string().min(1).max(120) });

app.post("/apps/:projectId/guardian/backup", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const target = backupTarget(await liveOwnedResources(projectId));
  if (!target) {
    return { ok: false, lines: ["No Neon or Supabase database is recorded for this app, so no backup was created.", ONE_ENVIRONMENT_NOTE] };
  }
  if (target.provider === "neon") {
    const values = await openProviderValues(user.id, "neon");
    if (!values?.apiKey) return { ok: false, lines: ["Neon is recorded, but ShipFix could not open that credential."] };
    const snap = await snapshotNeonDatabase(values.apiKey, target.externalId, { prefix: NEON_BACKUP_PREFIX, keep: 8 });
    if (!snap.ok) return { ok: false, lines: [snap.message] };
    return { ok: true, lines: [`Neon backup branch ${snap.branchName} was created. It is a copy of the default branch. Restore replaces the default branch with it and keeps the current data under a new name.`] };
  }
  const values = await openProviderValues(user.id, "supabase");
  if (!values?.accessToken) return { ok: false, lines: ["Supabase is recorded, but ShipFix could not open that credential."] };
  const name = `sf${Date.now().toString(36).slice(-8)}`;
  const point = await createSupabaseRestorePoint(values.accessToken, target.externalId, name, { waitMs: 20_000, pollMs: 1_000 });
  if (!point.ok) return { ok: false, lines: [point.message] };
  return { ok: true, lines: [`Supabase restore point ${point.value} was created. Restore it from the Supabase dashboard. ShipFix does not overwrite that database.`] };
});

app.post("/apps/:projectId/guardian/restore", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const parsed = RestoreBody.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_body", message: "Name the backup branch and the repo." });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  if (parsed.data.confirm !== found.project.repoFullName) {
    return reply.status(400).send({ error: "confirm_mismatch", message: "Type the repo name to restore this database." });
  }
  const target = backupTarget(await liveOwnedResources(projectId));
  if (!target || target.provider !== "neon") {
    return reply.status(409).send({ error: "no_neon_backup", message: "A Neon backup restore needs a Neon database recorded for this app." });
  }
  const values = await openProviderValues(user.id, "neon");
  if (!values?.apiKey) return reply.status(409).send({ error: "credential_unavailable", message: "ShipFix could not open the Neon credential." });
  const restored = await restoreNeonBranch(values.apiKey, target.externalId, parsed.data.branchName);
  if (!restored.ok) return reply.status(409).send({ error: "restore_failed", message: restored.message });
  return { ok: true, lines: [`The default branch was replaced from ${parsed.data.branchName}. The previous data is kept as ${restored.branchName}.`] };
});

app.post("/apps/:projectId/guardian/domain", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const parsed = DomainBody.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_body", message: "Enter a hostname." });
  const hostname = validHostname(parsed.data.hostname);
  if (!hostname) return reply.status(400).send({ error: "invalid_hostname", message: "Enter a hostname such as app.example.com." });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const target = domainTarget(await liveOwnedResources(projectId));
  if (!target) return { ok: false, lines: ["No Vercel project or Render service is recorded, so the domain was not attached."] };
  const values = await openProviderValues(user.id, target.provider);
  const result = await attachHostname(target, hostname, {
    vercelToken: values?.apiToken,
    vercelTeamId: values?.teamId,
    renderKey: values?.apiKey,
  }, fetch);
  return result;
});

app.post("/apps/:projectId/guardian/teardown", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const parsed = ConfirmBody.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_body", message: "Type the repo name to tear the app down." });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  if (parsed.data.confirm !== found.project.repoFullName) {
    return reply.status(400).send({ error: "confirm_mismatch", message: "Type the repo name to tear the app down." });
  }
  const owned = await liveOwnedResources(projectId);
  const steps = planTeardown(owned);
  if (steps.length === 0) return { ok: true, lines: ["Nothing ShipFix created is still recorded for this app."] };
  const creds = {
    vercel: await openProviderValues(user.id, "vercel"),
    render: await openProviderValues(user.id, "render"),
    neon: await openProviderValues(user.id, "neon"),
    upstash: await openProviderValues(user.id, "upstash"),
  };
  const lines: string[] = [];
  let ok = true;
  for (const step of steps) {
    const result = await deleteProviderResource(step, {
      vercelToken: creds.vercel?.apiToken,
      vercelTeamId: creds.vercel?.teamId,
      renderKey: creds.render?.apiKey,
      neonKey: creds.neon?.apiKey,
      upstashEmail: creds.upstash?.email,
      upstashKey: creds.upstash?.apiKey,
    }, fetch);
    lines.push(result.line);
    if (!result.ok) ok = false;
    if (result.ok && step.action === "delete") {
      const ids = owned.find((resource) => resource.provider === step.provider && resource.externalId === step.externalId)?.ids ?? [];
      if (ids.length > 0) {
        await db.update(deployedResources).set({ status: "removed" }).where(inArray(deployedResources.id, ids));
      }
    }
  }
  lines.push(ONE_ENVIRONMENT_NOTE);
  return { ok, lines };
});

function stripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim() && env.STRIPE_WEBHOOK_SECRET?.trim() && env.STRIPE_GUARDIAN_PRICE_ID?.trim());
}

async function applySubscription(update: SubscriptionUpdate): Promise<void> {
  if (!z.string().uuid().safeParse(update.projectId).success) return;
  await db
    .update(projects)
    .set({
      plan: update.plan,
      stripeCustomerId: update.customerId,
      stripeSubscriptionId: update.subscriptionId,
      subscriptionStatus: update.status,
    })
    .where(eq(projects.id, update.projectId));
}

function publicAppOrigin(): string {
  const origin = env.WEB_ORIGIN?.trim();
  if (origin && origin !== "*") return origin.replace(/\/$/, "");
  return "http://localhost:3000";
}

function stripeError(body: unknown): string {
  const message = body && typeof body === "object" ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  const text = typeof message === "string" ? message.slice(0, 200) : "Stripe did not complete this request.";
  const secret = env.STRIPE_SECRET_KEY?.trim();
  return secret ? text.split(secret).join("a Stripe key") : text;
}

async function stripeRequest(path: string, init?: { method?: string; body?: URLSearchParams }): Promise<{ status: number; body: unknown }> {
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? "";
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        ...(init?.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init?.body,
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

app.get("/apps/:projectId/billing", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  const configured = stripeConfigured();
  return {
    configured,
    plan: found.project.plan,
    status: found.project.subscriptionStatus,
    guardianOpen: configured ? guardianEntitled(found.project.plan, found.project.subscriptionStatus) : true,
    offers: PLAN_OFFERS,
  };
});

app.post("/apps/:projectId/billing/checkout", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  if (!stripeConfigured()) {
    return reply.status(503).send({
      error: "billing_unconfigured",
      message: "Stripe is not connected on this server, so no card is charged. This app stays on Free.",
    });
  }
  const origin = publicAppOrigin();
  const created = await stripeRequest("/checkout/sessions", {
    method: "POST",
    body: checkoutForm({
      priceId: env.STRIPE_GUARDIAN_PRICE_ID!.trim(),
      projectId,
      successUrl: `${origin}/apps/${projectId}?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/apps/${projectId}?billing=cancel`,
    }),
  });
  const url = created.body && typeof created.body === "object" ? (created.body as { url?: unknown }).url : undefined;
  if (created.status < 200 || created.status >= 300 || typeof url !== "string") {
    return reply.status(502).send({ error: "stripe_rejected", message: stripeError(created.body) });
  }
  return { url };
});

const ConfirmSessionBody = z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/) });

app.post("/apps/:projectId/billing/confirm", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) return reply.status(400).send({ error: "invalid_project_id" });
  const parsed = ConfirmSessionBody.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_body", message: "Missing the Stripe checkout session." });
  const found = await guardianLive(user.id, projectId);
  if (!found) return reply.status(404).send({ error: "project_not_found" });
  if (!stripeConfigured()) {
    return reply.status(503).send({ error: "billing_unconfigured", message: "Stripe is not connected on this server." });
  }
  const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(parsed.data.sessionId)}`);
  if (session.status < 200 || session.status >= 300) {
    return reply.status(502).send({ error: "stripe_rejected", message: stripeError(session.body) });
  }
  const update = subscriptionFromEvent({ type: "checkout.session.completed", data: { object: session.body } });
  if (!update || update.projectId !== projectId) {
    return reply.status(409).send({ error: "checkout_not_paid", message: "Stripe has not marked this checkout as paid." });
  }
  await applySubscription(update);
  return { plan: update.plan, status: update.status };
});

// ── GitHub App installations ────────────────────────────────────────────────
// Ownership is proven by a GitHub user OAuth code (the App's "request user
// authorization during installation" setting): we only record installations that
// GitHub itself lists for the authenticated GitHub user.
app.get("/github/installations", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const config = loadGithubAppConfigFromEnv();
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      createdAt: githubInstallations.createdAt,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id));
  return {
    configured: Boolean(config),
    claimable: Boolean(config?.clientId && config?.clientSecret),
    installUrl: githubAppInstallUrl(config),
    installations: rows,
  };
});

const ClaimInstallationBody = z.object({
  code: z.string().min(1).max(200),
  installationId: z.string().regex(/^\d+$/).optional(),
});

app.post("/github/installations/claim", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const parsed = ClaimInstallationBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }
  const config = loadGithubAppConfigFromEnv();
  if (!config?.clientId || !config.clientSecret) {
    return reply.status(503).send({
      error: "github_app_unconfigured",
      message: "The ShipFix GitHub App is not fully configured on this server.",
    });
  }

  let installations;
  try {
    const userToken = await exchangeGithubUserCode(config, parsed.data.code);
    installations = await listGithubUserInstallations(userToken);
  } catch (err) {
    request.log.warn({ err }, "GitHub installation claim failed");
    return reply.status(400).send({
      error: "github_oauth_failed",
      message: "GitHub did not confirm this installation. Start the GitHub connection again.",
    });
  }

  if (parsed.data.installationId && !installations.some((i) => i.installationId === parsed.data.installationId)) {
    return reply.status(403).send({
      error: "installation_not_accessible",
      message: "Your GitHub account does not have access to that installation.",
    });
  }

  for (const inst of installations) {
    await db
      .insert(githubInstallations)
      .values({
        userId: user.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
      })
      .onConflictDoUpdate({
        target: [githubInstallations.userId, githubInstallations.installationId],
        set: { accountLogin: inst.accountLogin, accountType: inst.accountType },
      });
  }
  return { ok: true, installations };
});

/** Repos from installations this user has claimed. Public paste still works when this is empty. */
app.get("/github/repos", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const config = loadGithubAppConfigFromEnv();
  if (!config) return { configured: false, repos: [] };
  const installations = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id));
  const repos: Array<{ fullName: string; private: boolean; defaultBranch: string }> = [];
  const seen = new Set<string>();
  for (const inst of installations) {
    try {
      const token = await createInstallationAccessToken(config, inst.installationId);
      for (const repo of await listInstallationRepositories(token)) {
        if (seen.has(repo.fullName)) continue;
        seen.add(repo.fullName);
        repos.push(repo);
      }
    } catch (err) {
      request.log.warn({ err, installationId: inst.installationId }, "GitHub repo list failed");
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { configured: true, repos };
});

app.delete("/github/installations/:installationId", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { installationId } = request.params as { installationId: string };
  await db
    .delete(githubInstallations)
    .where(and(eq(githubInstallations.userId, user.id), eq(githubInstallations.installationId, installationId)));
  await db
    .update(projects)
    .set({ githubInstallationId: null })
    .where(and(eq(projects.userId, user.id), eq(projects.githubInstallationId, installationId)));
  return { ok: true };
});

// ── Provider credentials ───────────────────────────────────────────────────
// The control plane is trusted and may receive a plaintext credential here; it
// is sealed (envelope-encrypted) immediately and never logged or returned.
async function saveProviderCredentials(
  userId: string,
  provider: string,
  values: Record<string, string>,
): Promise<{ id: string; created: boolean }> {
  const vault = createSecretVaultFromEnv();
  const sealed = await vault.seal(JSON.stringify(values));
  const existing = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, provider)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(providerAccounts)
      .set({ encDek: sealed.encDek, encBlob: sealed.encBlob, encIv: sealed.encIv })
      .where(eq(providerAccounts.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }
  const [created] = await db
    .insert(providerAccounts)
    .values({
      userId,
      provider,
      encDek: sealed.encDek,
      encBlob: sealed.encBlob,
      encIv: sealed.encIv,
    })
    .returning();
  if (!created) throw new Error("Provider account was not saved.");
  return { id: created.id, created: true };
}
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
    createSecretVaultFromEnv();
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({
      error: "vault_unconfigured",
      message: "ShipFix's secret storage is not configured on the server, so credentials cannot be saved yet.",
    });
  }

  try {
    const saved = await saveProviderCredentials(user.id, parsed.data.provider, parsed.data.values);
    return reply.status(saved.created ? 201 : 200).send({
      id: saved.id,
      provider: parsed.data.provider,
      ...(saved.created ? {} : { updated: true }),
    });
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

/** Which providers can be connected with a login instead of a pasted key. No secrets. */
app.get("/providers/oauth", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  return { providers: loadOauthApps().map((app) => app.provider) };
});

const OauthStartBody = z.object({
  redirectUri: z.string().url().max(300),
});

app.post("/providers/:provider/oauth/start", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { provider } = request.params as { provider: string };
  const app = loadOauthApp(provider);
  if (!app) {
    return reply.status(404).send({
      error: "oauth_unconfigured",
      message: "This provider is not set up for login on this ShipFix server. Paste a key instead.",
    });
  }
  const parsed = OauthStartBody.safeParse(request.body);
  if (!parsed.success || !allowedOauthRedirect(parsed.data.redirectUri, env.WEB_ORIGIN)) {
    return reply.status(400).send({
      error: "invalid_redirect",
      message: "The provider login has to return to this ShipFix app.",
    });
  }
  const pkce = app.provider === "vercel" ? undefined : createPkce();
  const state = signOauthState(app.clientSecret, {
    userId: user.id,
    provider: app.provider,
    exp: Date.now() + 10 * 60 * 1000,
  });
  return {
    authorizeUrl: authorizeUrl(app, {
      redirectUri: parsed.data.redirectUri,
      state,
      challenge: pkce?.challenge,
    }),
    state,
    ...(pkce ? { verifier: pkce.verifier } : {}),
  };
});

const OauthCompleteBody = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(2000),
  redirectUri: z.string().url().max(300),
  verifier: z.string().min(1).max(200).optional(),
});

app.post("/providers/oauth/complete", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const parsed = OauthCompleteBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }
  const provider = peekOauthProvider(parsed.data.state);
  const app = provider ? loadOauthApp(provider) : null;
  if (!app || !verifyOauthState(app.clientSecret, parsed.data.state, { userId: user.id, provider: app.provider })) {
    return reply.status(400).send({
      error: "oauth_state_invalid",
      message: "This provider login expired. Start it again from ShipFix.",
    });
  }
  if (!allowedOauthRedirect(parsed.data.redirectUri, env.WEB_ORIGIN)) {
    return reply.status(400).send({
      error: "invalid_redirect",
      message: "ShipFix could not confirm where the provider should return.",
    });
  }
  let values: Record<string, string>;
  try {
    values = await exchangeOauthCode(app, {
      code: parsed.data.code,
      redirectUri: parsed.data.redirectUri,
      verifier: parsed.data.verifier,
    });
  } catch (err) {
    request.log.warn({ err, provider: app.provider }, "Provider OAuth exchange failed");
    return reply.status(400).send({
      error: "oauth_exchange_failed",
      message: "The provider did not accept this login. Start it again.",
    });
  }
  const preflight = await preflightProviderCredentials(app.provider, values);
  if (!preflight.ok) {
    return reply.status(422).send({
      error: "credential_rejected",
      message: preflight.message ?? "The provider rejected this login.",
    });
  }
  try {
    createSecretVaultFromEnv();
    await saveProviderCredentials(user.id, app.provider, values);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "internal",
      message: "ShipFix hit an internal error saving this connection. Try again in a minute.",
    });
  }
  return { ok: true, provider: app.provider };
});

app.delete("/provider-accounts/:provider", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { provider } = request.params as { provider: string };
  if (!/^[a-z0-9_-]{1,40}$/.test(provider)) {
    return reply.status(400).send({ error: "invalid_provider" });
  }
  await db
    .delete(providerAccounts)
    .where(and(eq(providerAccounts.userId, user.id), eq(providerAccounts.provider, provider)));
  return { ok: true };
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
app.post("/runs/:runId/events/ticket", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;
  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }
  return issueStreamTicket(streamKey, { userId: user.id, runId });
});

/** Recent redacted log lines. Bearer auth, unlike the SSE stream which uses a ticket. */
app.get("/runs/:runId/logs", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }
  const raw = Number((request.query as { limit?: string } | undefined)?.limit ?? 80);
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 80;
  const rows = await db
    .select({ seq: runEvents.seq, level: runEvents.level, message: runEvents.message })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "log")))
    .orderBy(desc(runEvents.seq))
    .limit(limit);
  return { lines: rows.reverse() };
});

app.get("/runs/:runId/events", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  const user = await requireStreamUser(request, reply, db, env, (ticket) =>
    verifyStreamTicket(streamKey, ticket, runId),
  );
  if (!user) return;
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
      autoDeployOnPush: project.autoDeployOnPush,
      createdAt: project.createdAt,
    },
    current,
    latestLiveDeployment,
    deployAction,
    history,
  };
});

const PatchAppBody = z.object({
  autoDeployOnPush: z.boolean().optional(),
});

/** Update project settings (e.g. auto-deploy on push). */
app.patch("/apps/:projectId", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }

  const parsed = PatchAppBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }
  if (parsed.data.autoDeployOnPush === undefined) {
    return reply.status(400).send({ error: "invalid_body", message: "No updatable fields provided." });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .limit(1);
  if (!project) return reply.status(404).send({ error: "project_not_found" });

  const [updated] = await db
    .update(projects)
    .set({ autoDeployOnPush: parsed.data.autoDeployOnPush })
    .where(eq(projects.id, projectId))
    .returning();

  return {
    project: {
      id: updated.id,
      repoFullName: updated.repoFullName,
      defaultBranch: updated.defaultBranch,
      autoDeployOnPush: updated.autoDeployOnPush,
      createdAt: updated.createdAt,
    },
  };
});

// Answer PlanQuestions (secrets sealed). Approach A: answer before Deploy.
const RunInputsBody = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .min(1),
});

app.post("/runs/:runId/inputs", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }

  const parsed = RunInputsBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  }

  const planRow = await db
    .select({ doc: plans.doc })
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(desc(plans.version))
    .limit(1);
  const planDoc = planRow[0]?.doc as {
    questions?: Array<{ id: string; kind?: string }>;
  } | null;
  if (!planDoc) {
    return reply.status(404).send({
      error: "plan_not_found",
      message: "No plan found for this run yet. Wait for planning to finish.",
    });
  }

  const questionsById = new Map(
    (planDoc.questions ?? []).map((q) => [q.id, q]),
  );
  for (const answer of parsed.data.answers) {
    if (!questionsById.has(answer.questionId)) {
      return reply.status(400).send({
        error: "unknown_question",
        message: `Question "${answer.questionId}" is not on this plan.`,
      });
    }
  }

  let vault: ReturnType<typeof createSecretVaultFromEnv>;
  try {
    vault = createSecretVaultFromEnv();
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({
      error: "vault_unconfigured",
      message: "ShipFix's secret storage is not configured on the server.",
    });
  }

  const answered: string[] = [];
  try {
    for (const answer of parsed.data.answers) {
      const question = questionsById.get(answer.questionId)!;
      const isSecret = question.kind === "secret";
      const existing = await db
        .select()
        .from(runInputs)
        .where(and(eq(runInputs.runId, runId), eq(runInputs.questionId, answer.questionId)))
        .limit(1);

      if (isSecret) {
        const sealed = await vault.seal(answer.value);
        if (existing[0]) {
          await db
            .update(runInputs)
            .set({
              isSecret: true,
              valuePlain: null,
              encBlob: sealed.encBlob,
              encIv: sealed.encIv,
              encDek: sealed.encDek,
            })
            .where(eq(runInputs.id, existing[0].id));
        } else {
          await db.insert(runInputs).values({
            runId,
            questionId: answer.questionId,
            isSecret: true,
            valuePlain: null,
            encBlob: sealed.encBlob,
            encIv: sealed.encIv,
            encDek: sealed.encDek,
          });
        }
      } else if (existing[0]) {
        await db
          .update(runInputs)
          .set({
            isSecret: false,
            valuePlain: answer.value,
            encBlob: null,
            encIv: null,
            encDek: null,
          })
          .where(eq(runInputs.id, existing[0].id));
      } else {
        await db.insert(runInputs).values({
          runId,
          questionId: answer.questionId,
          isSecret: false,
          valuePlain: answer.value,
        });
      }
      answered.push(answer.questionId);
    }
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "internal",
      message: "Could not save answers. Try again in a minute.",
    });
  }

  try {
    await signalInputWait(runId);
  } catch (err) {
    request.log.warn({ err }, "Saved answers, but could not resume the waiting deploy.");
  }

  return { ok: true, answered };
});

/**
 * Revalidate plan after HITL answers / project env without LLM replan (C2).
 * Optionally start deploy when the plan becomes deployable.
 */
app.post("/runs/:runId/continue", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { runId } = request.params as { runId: string };
  if (!z.string().uuid().safeParse(runId).success) {
    return reply.status(400).send({ error: "invalid_run_id" });
  }
  if (!(await userCanAccessRun(user.id, runId))) {
    return reply.status(404).send({ error: "run_not_found" });
  }

  const body = z
    .object({ startDeploy: z.boolean().optional() })
    .safeParse(request.body ?? {});
  if (!body.success) {
    return reply.status(400).send({ error: "invalid_body", details: body.error.flatten() });
  }

  let result: Awaited<ReturnType<typeof revalidatePlanForRun>>;
  try {
    result = await revalidatePlanForRun(db, runId);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "revalidate_failed",
      message: err instanceof Error ? err.message : "Could not revalidate this plan.",
    });
  }

  if (result.changed) {
    const logger = createRunLogger(runId, createSafePostgresSink(db));
    await logger.log("Plan revalidated after answers", {
      event: "plan_revalidated",
      classification: result.classification,
      hadRepoContext: result.hadRepoContext,
    });
  }

  if (body.data.startDeploy && result.classification === "deployable") {
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
    const deploy = await startDeployFromExistingRun(user, runId);
    if (!deploy.ok) {
      const status =
        deploy.code === "run_not_found"
          ? 404
          : deploy.code === "plan_not_found"
            ? 400
            : deploy.runId
              ? 503
              : 429;
      return reply.status(status).send({
        runId: deploy.runId || undefined,
        error: deploy.code,
        message: deploy.message,
        classification: result.classification,
        deployable: true,
        plan: normalizePlanForResponse(result.plan),
      });
    }
    return reply.status(202).send({
      runId: deploy.runId,
      mode: "deploy",
      classification: result.classification,
      deployable: true,
      changed: result.changed,
      plan: normalizePlanForResponse(result.plan),
    });
  }

  return {
    classification: result.classification,
    deployable: result.classification === "deployable",
    changed: result.changed,
    hadRepoContext: result.hadRepoContext,
    plan: normalizePlanForResponse(result.plan),
  };
});

const EnvVarName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env var name");

const ProjectEnvPutBody = z.object({
  vars: z
    .array(
      z.object({
        name: EnvVarName,
        value: z.string().min(1),
        isSecret: z.boolean().default(true),
      }),
    )
    .min(1),
});

async function userOwnsProject(userId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** List durable project env vars (secret values never returned). */
app.get("/apps/:projectId/env", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  if (!(await userOwnsProject(user.id, projectId))) {
    return reply.status(404).send({ error: "project_not_found" });
  }

  const rows = await db
    .select({
      name: projectEnvVars.name,
      isSecret: projectEnvVars.isSecret,
      valuePlain: projectEnvVars.valuePlain,
      updatedAt: projectEnvVars.updatedAt,
    })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId))
    .orderBy(asc(projectEnvVars.name));

  return {
    vars: rows.map((r) => ({
      name: r.name,
      isSecret: r.isSecret,
      value: r.isSecret ? null : r.valuePlain,
      updatedAt: r.updatedAt,
    })),
  };
});

/** Upsert durable project env vars. Secrets are sealed; never echoed back. */
app.put("/apps/:projectId/env", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { projectId } = request.params as { projectId: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  if (!(await userOwnsProject(user.id, projectId))) {
    return reply.status(404).send({ error: "project_not_found" });
  }

  const parsed = ProjectEnvPutBody.safeParse(request.body);
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
      message: "ShipFix's secret storage is not configured on the server.",
    });
  }

  const saved: string[] = [];
  try {
    for (const item of parsed.data.vars) {
      const existing = await db
        .select()
        .from(projectEnvVars)
        .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.name, item.name)))
        .limit(1);

      const now = new Date();
      if (item.isSecret) {
        const sealed = await vault.seal(item.value);
        if (existing[0]) {
          await db
            .update(projectEnvVars)
            .set({
              isSecret: true,
              valuePlain: null,
              encBlob: sealed.encBlob,
              encIv: sealed.encIv,
              encDek: sealed.encDek,
              updatedAt: now,
            })
            .where(eq(projectEnvVars.id, existing[0].id));
        } else {
          await db.insert(projectEnvVars).values({
            projectId,
            name: item.name,
            isSecret: true,
            valuePlain: null,
            encBlob: sealed.encBlob,
            encIv: sealed.encIv,
            encDek: sealed.encDek,
          });
        }
      } else if (existing[0]) {
        await db
          .update(projectEnvVars)
          .set({
            isSecret: false,
            valuePlain: item.value,
            encBlob: null,
            encIv: null,
            encDek: null,
            updatedAt: now,
          })
          .where(eq(projectEnvVars.id, existing[0].id));
      } else {
        await db.insert(projectEnvVars).values({
          projectId,
          name: item.name,
          isSecret: false,
          valuePlain: item.value,
        });
      }
      saved.push(item.name);
    }
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({
      error: "internal",
      message: "Could not save environment variables. Try again in a minute.",
    });
  }

  return { ok: true, saved };
});

app.delete("/apps/:projectId/env/:name", async (request, reply) => {
  const user = await requireUser(request, reply, db, env);
  if (!user) return;

  const { projectId, name } = request.params as { projectId: string; name: string };
  if (!z.string().uuid().safeParse(projectId).success) {
    return reply.status(400).send({ error: "invalid_project_id" });
  }
  if (!EnvVarName.safeParse(name).success) {
    return reply.status(400).send({ error: "invalid_env_name" });
  }
  if (!(await userOwnsProject(user.id, projectId))) {
    return reply.status(404).send({ error: "project_not_found" });
  }

  await db
    .delete(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.name, name)));

  return { ok: true };
});

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
