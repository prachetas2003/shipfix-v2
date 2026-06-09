import type {
  DeploymentPlan,
  ManagedKind,
  PlanClassification,
  PlanProvider,
  RepoContext,
  ServiceType,
  PlanService,
} from "@shipfix/contracts";
import {
  analyzeRepo as runAnalyzer,
  repoSourceFromSandbox,
} from "@shipfix/analyzer";
import { createLocalDevSandboxProvider } from "@shipfix/sandbox/dev";
import { createSafePostgresSink, createRunLogger, type RunLogger } from "@shipfix/observability";
import { createLLMGateway } from "@shipfix/llm";
import { generatePlan as runPlanner } from "@shipfix/planner";
import {
  validatePlan as runValidator,
  capabilities as buildCapabilities,
  type Capabilities,
  type ManagedProvider,
} from "@shipfix/validator";
import { AdapterRegistry, type DeployFailureKind } from "@shipfix/adapter-core";
import { createRenderAdapter } from "@shipfix/adapter-render";
import { createVercelAdapter } from "@shipfix/adapter-vercel";
import {
  ProvisionerRegistry,
  createNeonProvisioner,
  type ManagedProviderId,
} from "@shipfix/provisioner";
import { verifyFromPlan } from "@shipfix/verifier";
import { resolveServiceEnv, type DeployedResourceRow } from "./resolveEnv";
import { buildRepoFixGuidance } from "./brokenRepoGuidance";
import {
  computeFinalizeDeployOutcome,
  evaluateDeployGate,
  type DeployRunOutcome,
  type DeploySummary,
  type PlanVerifySummary,
  type ProvisionSummary,
} from "./finalizeDeployRun";
import { createSecretVaultFromEnv, type SecretVault } from "@shipfix/secrets";
import {
  createDb,
  llmUsage,
  runs,
  projects,
  plans,
  providerAccounts,
  deployedResources,
  type Database,
} from "@shipfix/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { LLMGateway, LLMRequest, LLMResult } from "@shipfix/llm";
import { failureEventForMessage, unwrapFailureMessage } from "./errorMessages";
import { llmUsageLimitMessage, workflowAlphaLimit } from "./alphaLimits";

/**
 * Temporal ACTIVITIES — the only side-effecting units.
 *
 * Activities (not the workflow) do I/O: sandbox, analyzer, DB, run-event sink.
 * They are individually retryable and isolated; the workflow stays deterministic
 * and just orchestrates them.
 *
 * Implemented: analyzeRepo + completeRun + failRun (analyze_only) and
 * proposePlan + finalizePlanRun (plan). Real deploy/provision/verify activities
 * remain explicit stubs — no fake capability.
 */

const notImplemented = (name: string): never => {
  throw new Error(`Activity "${name}" not implemented yet.`);
};

// ── Lazily-initialized control-plane DB (one pool per worker process) ────────
let _db: Database | undefined;
function getDb(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (required by worker activities).");
    _db = createDb(url);
  }
  return _db;
}

interface RunRow {
  id: string;
  projectId: string;
  userId: string;
  commitSha: string;
  mode: string;
}

async function loadRun(
  db: Database,
  runId: string,
): Promise<{ run: RunRow; repoFullName: string; defaultBranch: string }> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .limit(1);
  if (!project) throw new Error(`Project ${run.projectId} for run ${runId} not found.`);
  return {
    run: { id: run.id, projectId: run.projectId, userId: project.userId, commitSha: run.commitSha, mode: run.mode },
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
  };
}

// ── Registries + vault (one per worker process) ──────────────────────────────
const provisioners = new ProvisionerRegistry();
provisioners.register(createNeonProvisioner());

const adapters = new AdapterRegistry();
adapters.register(createRenderAdapter());
adapters.register(createVercelAdapter());

let _vault: SecretVault | undefined;
function getVault(): SecretVault {
  if (!_vault) _vault = createSecretVaultFromEnv();
  return _vault;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function providerFromEnv(): string {
  return process.env.LLM_PROVIDER ?? "unknown";
}

function estimateCostCents(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  void model;
  const perMillion =
    provider === "openai"
      ? { input: 5, output: 15 }
      : provider === "anthropic"
        ? { input: 3, output: 15 }
        : provider === "gemini"
          ? { input: 1, output: 3 }
          : { input: 0, output: 0 };
  return (inputTokens / 1_000_000) * perMillion.input * 100 + (outputTokens / 1_000_000) * perMillion.output * 100;
}

async function countLlmAttemptRows(
  db: Database,
  where: ReturnType<typeof and>,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(llmUsage)
    .where(and(
      where,
      sql`${llmUsage.provider} <> 'shipfix'`,
      sql`(${llmUsage.error} is null or ${llmUsage.error} not in ('alpha_llm_limit', 'llm_run_limit', 'llm_daily_user_limit'))`,
    ));
  return Number(rows[0]?.count ?? 0);
}

export function meteredGateway(
  inner: LLMGateway,
  db: Database,
  meta: { userId: string; projectId: string; runId: string; operation: string },
): LLMGateway {
  const provider = providerFromEnv();
  return {
    model: inner.model,
    async complete(req: LLMRequest): Promise<LLMResult> {
      const maxPerRun = workflowAlphaLimit("ALPHA_MAX_LLM_CALLS_PER_RUN");
      const maxPerUserDay = workflowAlphaLimit("ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY");
      const runCalls = await countLlmAttemptRows(db, and(eq(llmUsage.runId, meta.runId)));
      const userCallsToday = await countLlmAttemptRows(
        db,
        and(eq(llmUsage.userId, meta.userId), gte(llmUsage.createdAt, startOfUtcDay())),
      );
      if (runCalls >= maxPerRun || userCallsToday >= maxPerUserDay) {
        const code = runCalls >= maxPerRun ? "llm_run_limit" : "llm_daily_user_limit";
        const limit = runCalls >= maxPerRun ? maxPerRun : maxPerUserDay;
        await db.insert(llmUsage).values({
          userId: meta.userId,
          projectId: meta.projectId,
          runId: meta.runId,
          provider,
          model: inner.model,
          operation: meta.operation,
          inputTokens: approximateTokens(req.system) + approximateTokens(req.user),
          outputTokens: 0,
          estimatedCostCents: 0,
          success: false,
          error: code,
        });
        throw new Error(llmUsageLimitMessage({ code, limit, nodeEnv: process.env.NODE_ENV }));
      }

      const inputEstimate = approximateTokens(req.system) + approximateTokens(req.user);
      try {
        const result = await inner.complete(req);
        const inputTokens = result.usage?.inputTokens ?? inputEstimate;
        const outputTokens = result.usage?.outputTokens ?? approximateTokens(result.text);
        await db.insert(llmUsage).values({
          userId: meta.userId,
          projectId: meta.projectId,
          runId: meta.runId,
          provider,
          model: result.model,
          operation: meta.operation,
          inputTokens,
          outputTokens,
          estimatedCostCents: estimateCostCents(provider, result.model, inputTokens, outputTokens),
          success: true,
        });
        return result;
      } catch (e) {
        await db.insert(llmUsage).values({
          userId: meta.userId,
          projectId: meta.projectId,
          runId: meta.runId,
          provider,
          model: inner.model,
          operation: meta.operation,
          inputTokens: inputEstimate,
          outputTokens: 0,
          estimatedCostCents: 0,
          success: false,
          error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        });
        throw e;
      }
    },
  };
}

/** deployed_resources.kind discriminator from a plan ManagedKind. */
function resourceKind(kind: ManagedKind): string {
  if (kind === "redis") return "managed_redis";
  if (kind === "object_storage") return "managed_object_storage";
  return "managed_db";
}

function neonOrgIdFromEnv(): string | null {
  return process.env.NEON_ORG_ID?.trim() || process.env.NEON_ORGANIZATION_ID?.trim() || null;
}

function neonOrgIdFromValues(values: Record<string, string>): string | null {
  return (
    values.orgId?.trim() ||
    values.org_id?.trim() ||
    values.organizationId?.trim() ||
    values.organization_id?.trim() ||
    neonOrgIdFromEnv()
  );
}

function providerReadyForRuntime(provider: string): boolean {
  if (provider === "neon") return Boolean(neonOrgIdFromEnv());
  return true;
}

/**
 * Real system capabilities = registered providers ∩ the credentials this user
 * has actually connected. No adapters are registered, so deploy `providers`
 * stays empty (services can't deploy yet); managed provisioning becomes
 * available only for providers the user connected.
 */
async function loadCapabilities(db: Database, userId: string): Promise<Capabilities> {
  const accounts = await db
    .select({ provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, userId));
  const connected = new Set(accounts.map((a) => a.provider).filter(providerReadyForRuntime));

  const managed = provisioners
    .ids()
    .filter((id): id is ManagedProviderId & ManagedProvider => connected.has(id));

  const providerServiceTypes: Partial<Record<PlanProvider, ServiceType[]>> = {};
  for (const id of ["render", "vercel"] as const) {
    if (adapters.has(id) && connected.has(id)) {
      providerServiceTypes[id] = [...adapters.get(id).supports];
    }
  }

  return buildCapabilities(providerServiceTypes, managed);
}

async function loadPlan(db: Database, runId: string): Promise<DeploymentPlan> {
  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(desc(plans.version))
    .limit(1);
  if (!planRow) throw new Error(`No plan found for run ${runId}.`);
  return planRow.doc as DeploymentPlan;
}

async function loadDeployedRows(db: Database, runId: string): Promise<DeployedResourceRow[]> {
  const rows = await db.select().from(deployedResources).where(eq(deployedResources.runId, runId));
  return rows.map((r) => ({
    serviceId: r.serviceId,
    status: r.status,
    url: r.url,
    exposesEnv: r.exposesEnv,
    encBlob: r.encBlob,
    encIv: r.encIv,
    encDek: r.encDek,
  }));
}

/**
 * On a repo-side deploy failure (build/timeout/deploy), emit a beginner-friendly
 * fix prompt + manual checklist. ShipFix never mutates the repo; this just hands
 * the user something to paste into Cursor/ChatGPT. No-op for setup_blocker.
 */
/** Serialize deploy_log lines so they cannot race on run_events.seq. */
function chainedDeployOnLog(
  logger: RunLogger,
  serviceId: string,
): { onLog: (line: string) => void; flush: () => Promise<void> } {
  let chain = Promise.resolve();
  return {
    onLog: (line) => {
      chain = chain.then(() => logger.log(line, { event: "deploy_log", serviceId }));
    },
    flush: () => chain,
  };
}

async function emitRepoFixGuidance(
  logger: RunLogger,
  args: {
    repoFullName: string;
    service: PlanService;
    provider: string;
    failureKind: DeployFailureKind;
    errorSummary: string;
  },
): Promise<void> {
  const guidance = buildRepoFixGuidance({
    repoFullName: args.repoFullName,
    service: args.service,
    provider: args.provider,
    failureKind: args.failureKind,
    errorSummary: args.errorSummary,
  });
  if (!guidance) return;
  await logger.warn(guidance.summary, {
    event: "deploy_fix_guidance",
    serviceId: args.service.id,
    stage: guidance.stage,
    checklist: guidance.checklist,
    fixPrompt: guidance.fixPrompt,
  });
}

function planHasUnsupportedServices(plan: DeploymentPlan, caps: Capabilities): boolean {
  for (const svc of plan.services) {
    const types = caps.providers.get(svc.provider);
    if (!types?.has(svc.type)) return true;
  }
  return false;
}

async function decryptProviderCredentials(
  vault: SecretVault,
  account: { encDek: Buffer; encBlob: Buffer; encIv: Buffer },
): Promise<Record<string, string>> {
  return JSON.parse(
    await vault.open({ encDek: account.encDek, encBlob: account.encBlob, encIv: account.encIv }),
  ) as Record<string, string>;
}

async function setStatus(
  db: Database,
  runId: string,
  status: string,
  finished = false,
): Promise<void> {
  await db
    .update(runs)
    .set({ status, ...(finished ? { finishedAt: new Date() } : {}) })
    .where(eq(runs.id, runId));
}

/**
 * Clone in a (DEV) sandbox + run deterministic static analysis -> RepoContext.
 * Emits the analyze_only event timeline as it goes; the final RepoContext rides
 * on the `analysis_completed` event so the UI can render it without a new table.
 */
export async function analyzeRepo(runId: string): Promise<RepoContext> {
  const db = getDb();
  const logger: RunLogger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName } = await loadRun(db, runId);

  await setStatus(db, runId, "analyzing");
  await logger.stage("analyzing", `Analyzing ${repoFullName}`);

  const provider = createLocalDevSandboxProvider();
  const sandbox = await provider.create({ runId });

  try {
    await logger.log("Cloning repository", {
      event: "repo_clone_started",
      repoFullName,
    });
    await sandbox.clone({ repoFullName, sha: run.commitSha, token: "" });

    const head = await sandbox.exec("git rev-parse HEAD", { timeoutMs: 30_000 });
    const commitSha = head.exitCode === 0 ? head.stdout.trim() : run.commitSha;
    await logger.log("Clone complete", { event: "repo_clone_completed", commitSha });

    await logger.log("Running static analysis", { event: "analysis_started" });
    const source = repoSourceFromSandbox(sandbox);
    const ctx = await runAnalyzer(source, { repoFullName, commitSha });

    for (const svc of ctx.services) {
      await logger.log(
        `Detected ${svc.role} service: ${svc.framework} (${svc.rootDir || "/"})`,
        { event: "service_detected", service: svc },
      );
    }
    await logger.log(`Found ${ctx.envRefs.length} environment variable reference(s)`, {
      event: "env_refs_detected",
      envRefs: ctx.envRefs,
    });
    await logger.log(`Detected ${ctx.dataNeeds.length} data need(s)`, {
      event: "data_needs_detected",
      dataNeeds: ctx.dataNeeds,
    });

    // Record the resolved commit on the run for traceability.
    if (commitSha && commitSha !== run.commitSha) {
      await db.update(runs).set({ commitSha }).where(eq(runs.id, runId));
    }

    await logger.log("Analysis complete", {
      event: "analysis_completed",
      repoContext: ctx,
    });
    return ctx;
  } catch (err) {
    await logger.error("Analysis failed", {
      event: "analysis_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await sandbox.dispose();
  }
}

/** Terminal success for an analyze_only run. */
export async function completeRun(runId: string): Promise<void> {
  const db = getDb();
  await setStatus(db, runId, "succeeded", true);
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  await logger.stage("succeeded", "Run completed");
}

/** Terminal failure: record status + emit a final (redacted) error event. */
export async function failRun(runId: string, message: string): Promise<void> {
  const db = getDb();
  await setStatus(db, runId, "failed", true);
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const failure = failureEventForMessage(message);
  await logger.error(failure.title, { event: failure.event, message });
}

/**
 * The planning brain: RepoContext -> proposed DeploymentPlan -> deterministic
 * validation -> persisted, validated plan. The LLM only PROPOSES; the validator
 * is the trust boundary and may downgrade classification / append blockers. The
 * validated plan (never the raw model output) is what we persist and return.
 */
export async function proposePlan(runId: string, ctx: RepoContext): Promise<DeploymentPlan> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run } = await loadRun(db, runId);

  await setStatus(db, runId, "planning");
  const existingPlan = run.mode === "deploy" ? await loadPlan(db, runId).catch(() => null) : null;
  if (existingPlan) {
    await logger.stage("planning", "Using the validated plan selected for this deploy");
    await logger.log("Using existing deployment plan", {
      event: "plan_reused",
      classification: existingPlan.classification,
      serviceCount: existingPlan.services.length,
      managedCount: existingPlan.managed.length,
    });
    return existingPlan;
  }

  await logger.stage("planning", "Generating a deployment plan from the analysis");

  let result: Awaited<ReturnType<typeof runPlanner>>;
  try {
    // Throws a clear, actionable error if backend-owned LLM env vars are
    // unset. We never fall back to a mock planner.
    const gateway = meteredGateway(createLLMGateway(), db, {
      userId: run.userId,
      projectId: run.projectId,
      runId,
      operation: "plan",
    });
    result = await runPlanner(ctx, gateway);
  } catch (err) {
    const message = unwrapFailureMessage(err);
    const failure = failureEventForMessage(message);
    await logger.error(failure.title, {
      event: failure.event,
      operation: "plan",
      message,
    });
    throw new Error(message);
  }

  await logger.log(
    `Proposed plan: ${result.plan.classification}, ${result.plan.services.length} service(s), ${result.plan.managed.length} managed`,
    {
      event: "plan_generated",
      model: result.model,
      usedFallback: result.usedFallback,
      proposedClassification: result.plan.classification,
      serviceCount: result.plan.services.length,
      managedCount: result.plan.managed.length,
    },
  );

  await setStatus(db, runId, "validating");
  await logger.stage("validating", "Validating the plan against repo evidence and capabilities");

  const caps = await loadCapabilities(db, run.userId);
  const { plan: validated, issues } = runValidator(result.plan, ctx, caps);
  const downgraded = validated.classification !== result.plan.classification;

  // Persist the VALIDATED plan (the trustworthy artifact) as version 1.
  const [planRow] = await db
    .insert(plans)
    .values({
      runId,
      version: 1,
      doc: validated,
      planner: result.usedFallback ? "fallback" : result.model,
      confidence: validated.confidence,
    })
    .returning();
  await db.update(runs).set({ planId: planRow.id }).where(eq(runs.id, runId));

  // The full validated plan rides on this event so the UI can render the
  // proposed graph without a new endpoint. It carries env var NAMES only.
  await logger.log("Validated deployment plan", {
    event: "plan_validated",
    plan: validated,
    classification: validated.classification,
    confidence: validated.confidence,
    issues: issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
    downgraded,
  });

  if (downgraded) {
    await logger.warn(
      "Deployment is not available in this build — the validator downgraded the plan. It is delivered as a diagnosis/preview.",
      {
        event: "plan_downgraded",
        from: result.plan.classification,
        to: validated.classification,
        issueCodes: issues.map((i) => i.code),
      },
    );
  }

  return validated;
}

/** Terminal outcome for a plan run: diagnosis (RED) vs. a ready plan. */
export async function finalizePlanRun(
  runId: string,
  classification: PlanClassification,
): Promise<void> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  if (classification === "diagnose_only") {
    await setStatus(db, runId, "diagnosed", true);
    await logger.stage("diagnosed", "Deployment not available in this build — diagnosis ready");
  } else {
    await setStatus(db, runId, "succeeded", true);
    await logger.stage("succeeded", "Deployment plan ready");
  }
}

/**
 * Deploy-admission gate (deploy mode only). Refuses to execute any provider
 * calls unless the validated plan is GREEN (`deployable`). YELLOW/RED plans are
 * finalized as `diagnosed` with the concrete setup checklist. Returns whether
 * the workflow may proceed to provisioning/deploy.
 */
export async function gateDeploy(runId: string): Promise<{ allow: boolean }> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const plan = await loadPlan(db, runId);
  const gate = evaluateDeployGate(plan);
  const needsNeonOrgId = plan.managed.some((m) => m.mode === "provision" && m.provider === "neon");
  if (gate.allow && needsNeonOrgId && !neonOrgIdFromEnv()) {
    const message = "Neon organization ID is missing. Add NEON_ORG_ID and restart API/worker.";
    await logger.warn(message, {
      event: "deploy_blocked",
      provider: "neon",
      code: "neon_org_id_missing",
      orgIdAvailable: false,
    });
    await setStatus(db, runId, "diagnosed", true);
    await logger.stage("diagnosed", message);
    return { allow: false };
  }
  if (gate.allow) return { allow: true };

  await logger.warn(gate.message, {
    event: "deploy_blocked",
    classification: plan.classification,
    blockers: plan.blockers
      .filter((b) => b.severity !== "warning")
      .map((b) => ({ severity: b.severity, title: b.title })),
  });
  await setStatus(db, runId, gate.status, true);
  await logger.stage(gate.status, gate.message);
  return { allow: false };
}

/**
 * Provision the plan's managed services (this slice: real Neon Postgres).
 *
 * For each `provision` managed service whose provider is both registered and
 * connected, this decrypts credentials just-in-time, calls the real provider
 * API, persists the resource to `deployed_resources` (sealing the secret
 * connection string), and proves reachability. `deployed_resources` doubles as
 * an idempotency ledger so a re-run never double-provisions a live resource.
 *
 * It does NOT deploy services (no adapters yet) and never logs secret values.
 */
export async function provisionManagedServices(runId: string): Promise<ProvisionSummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run } = await loadRun(db, runId);

  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(desc(plans.version))
    .limit(1);
  if (!planRow) throw new Error(`No plan found for run ${runId}.`);
  const plan = planRow.doc as DeploymentPlan;

  const summary: ProvisionSummary = { provisioned: [], failed: [], skipped: [] };
  const targets = plan.managed.filter((m) => m.mode === "provision");
  if (targets.length === 0) {
    await logger.log("No managed services to provision.", { event: "provision_skipped" });
    return summary;
  }

  await setStatus(db, runId, "provisioning");
  await logger.stage("provisioning", `Provisioning ${targets.length} managed service(s)`);

  const vault = getVault();
  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, run.userId));
  const accountByProvider = new Map(accounts.map((a) => [a.provider, a]));

  for (const m of targets) {
    if (!m.provider) {
      summary.skipped.push({ id: m.id, reason: "no_provider" });
      continue;
    }
    const provisioner = provisioners.get(m.provider as ManagedProviderId);
    if (!provisioner) {
      summary.skipped.push({ id: m.id, reason: "no_provisioner" });
      await logger.warn(`No provisioner registered for "${m.provider}" — skipping ${m.id}.`, {
        event: "provision_skipped",
        managedId: m.id,
        provider: m.provider,
      });
      continue;
    }
    const account = accountByProvider.get(m.provider);
    if (!account) {
      summary.skipped.push({ id: m.id, reason: "not_connected" });
      await logger.warn(`Connect a ${m.provider} credential to provision "${m.id}".`, {
        event: "provision_needs_credential",
        managedId: m.id,
        provider: m.provider,
      });
      continue;
    }

    // Idempotency ledger: never double-provision a live resource on re-run.
    const [existing] = await db
      .select()
      .from(deployedResources)
      .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, m.id)))
      .limit(1);
    if (existing && existing.status === "live") {
      summary.skipped.push({ id: m.id, reason: "already_provisioned" });
      continue;
    }

    // Decrypt credentials JUST-IN-TIME (never persisted/logged in the clear).
    const credValues = JSON.parse(
      await vault.open({ encDek: account.encDek, encBlob: account.encBlob, encIv: account.encIv }),
    ) as Record<string, string>;
    const values = { ...credValues };
    if (m.provider === "neon") {
      const orgId = neonOrgIdFromValues(values);
      await logger.log(`Neon organization ID available: ${Boolean(orgId)}`, {
        event: "neon_config_check",
        managedId: m.id,
        orgIdAvailable: Boolean(orgId),
      });
      if (orgId) values.orgId = orgId;
    }
    const credentials = { provider: m.provider as ManagedProviderId, values };

    await logger.log(`Provisioning ${m.kind} via ${m.provider} for "${m.id}"`, {
      event: "provision_started",
      managedId: m.id,
      provider: m.provider,
      kind: m.kind,
    });

    const result = await provisioner.provision({
      resourceName: `shipfix-${runId}-${m.id}`,
      managed: m,
      credentials,
      onLog: (line) => void logger.log(line, { event: "provision_log", managedId: m.id }),
    });

    if (!result.ok || !result.exposed) {
      summary.failed.push(m.id);
      await db.insert(deployedResources).values({
        runId,
        serviceId: m.id,
        kind: resourceKind(m.kind),
        provider: m.provider,
        externalId: result.externalId,
        url: result.host,
        status: "failed",
        exposesEnv: m.exposesEnv,
      });
      await logger.error(`Provisioning failed for "${m.id}".`, {
        event: "provision_failed",
        managedId: m.id,
        detail: result.logs,
      });
      continue;
    }

    // Prove the resource is actually reachable (real evidence).
    const verdict = await provisioner.verify(result.exposed);
    const verifyPayload = {
      event: "verification",
      check: "db_connect",
      managedId: m.id,
      ok: verdict.ok,
      detail: verdict.detail,
    };
    if (!verdict.ok) {
      summary.failed.push(m.id);
      await db.insert(deployedResources).values({
        runId,
        serviceId: m.id,
        kind: resourceKind(m.kind),
        provider: m.provider,
        externalId: result.externalId,
        url: result.host,
        status: "failed",
        exposesEnv: m.exposesEnv,
      });
      await logger.error(`Database verification failed for "${m.id}".`, verifyPayload);
      continue;
    }

    await logger.log(`Verification for "${m.id}": reachable`, verifyPayload);

    // Seal the SECRET connection string before it touches the database.
    const sealed = await vault.seal(result.exposed.value);
    await db.insert(deployedResources).values({
      runId,
      serviceId: m.id,
      kind: resourceKind(m.kind),
      provider: m.provider,
      externalId: result.externalId,
      url: result.host, // non-secret host only
      status: "live",
      exposesEnv: result.exposed.name,
      encBlob: sealed.encBlob,
      encIv: sealed.encIv,
      encDek: sealed.encDek,
    });

    summary.provisioned.push(m.id);
    await logger.log(`Provisioned "${m.id}" (${m.provider} ${m.kind})`, {
      event: "resource_provisioned",
      managedId: m.id,
      provider: m.provider,
      kind: m.kind,
      externalId: result.externalId,
      host: result.host,
      exposesEnv: result.exposed.name,
      verified: verdict.ok,
    });
  }

  return summary;
}

/**
 * Deploy backend services from the validated plan (this slice: Render node_api only).
 * Resolves env (including sealed DATABASE_URL) in trusted worker code, then
 * calls the real adapter. Never logs secret env values.
 */
export async function deployBackendServices(runId: string): Promise<DeploySummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, defaultBranch } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const caps = await loadCapabilities(db, run.userId);
  const vault = getVault();

  const summary: DeploySummary = { deployed: [], failed: [], skipped: [] };
  const backendTargets = plan.services.filter(
    (s) => s.type === "node_api" && s.provider === "render",
  );
  if (backendTargets.length === 0) {
    await logger.log("No Render node_api services in plan.", { event: "deploy_skipped" });
    return summary;
  }

  await setStatus(db, runId, "deploying");
  await logger.stage("deploying", `Deploying ${backendTargets.length} backend service(s)`);

  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, run.userId));
  const accountByProvider = new Map(accounts.map((a) => [a.provider, a]));
  const deployedRows = await loadDeployedRows(db, runId);

  if (!adapters.has("render") || !accountByProvider.has("render")) {
    for (const s of backendTargets) {
      summary.skipped.push({ id: s.id, reason: "render_not_connected" });
    }
    await logger.warn("Connect a Render API key to deploy the backend.", { event: "deploy_needs_credential" });
    return summary;
  }

  const adapter = adapters.get("render");
  const renderAccount = accountByProvider.get("render")!;
  const credValues = await decryptProviderCredentials(vault, renderAccount);

  for (const svc of backendTargets) {
    const types = caps.providers.get("render");
    if (!types?.has("node_api")) {
      summary.skipped.push({ id: svc.id, reason: "capability_missing" });
      continue;
    }

    const [existing] = await db
      .select()
      .from(deployedResources)
      .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, svc.id)))
      .limit(1);
    if (existing?.status === "live" && existing.url) {
      summary.skipped.push({ id: svc.id, reason: "already_deployed" });
      continue;
    }

    const { env, issues } = await resolveServiceEnv(svc, plan, deployedRows, vault);
    if (issues.length > 0) {
      summary.skipped.push({ id: svc.id, reason: issues[0]?.code ?? "env_unresolved" });
      await logger.warn(`Cannot deploy "${svc.id}": env resolution blocked.`, {
        event: "deploy_env_blocked",
        serviceId: svc.id,
        issues: issues.map((i) => i.code),
      });
      continue;
    }

    await logger.log(`Deploying backend "${svc.id}" to Render`, {
      event: "deploy_started",
      serviceId: svc.id,
      provider: "render",
    });

    const deployLogs = chainedDeployOnLog(logger, svc.id);
    const result = await adapter.deploy({
      service: svc,
      repo: { fullName: repoFullName, branch: defaultBranch, commitSha: run.commitSha },
      rootDir: svc.rootDir,
      resourceName: `shipfix-${runId}-${svc.id}`.slice(0, 60),
      env,
      credentials: { provider: "render", values: credValues },
      onLog: deployLogs.onLog,
    });
    await deployLogs.flush();

    if (!result.ok || !result.publicUrl) {
      const kind = result.failureKind ?? "deploy_failed";
      summary.failed.push({ id: svc.id, kind });
      await db.insert(deployedResources).values({
        runId,
        serviceId: svc.id,
        kind: "service",
        provider: "render",
        externalId: result.externalId,
        url: result.publicUrl,
        status: "failed",
      });
      await logger.error(`Deploy failed for "${svc.id}".`, {
        event: kind === "setup_blocker" ? "deploy_setup_blocker" : "deploy_failed",
        serviceId: svc.id,
        failureKind: kind,
        detail: result.logs,
      });
      await emitRepoFixGuidance(logger, {
        repoFullName,
        service: svc,
        provider: "render",
        failureKind: kind,
        errorSummary: result.logs,
      });
      continue;
    }

    await db.insert(deployedResources).values({
      runId,
      serviceId: svc.id,
      kind: "service",
      provider: "render",
      externalId: result.externalId,
      url: result.publicUrl,
      status: "live",
    });

    summary.deployed.push(svc.id);
    await logger.log(`Backend "${svc.id}" deployed`, {
      event: "service_deployed",
      serviceId: svc.id,
      provider: "render",
      serviceRole: "backend",
      externalId: result.externalId,
      publicUrl: result.publicUrl,
    });
  }

  return summary;
}

/**
 * Deploy frontend_static services to Vercel. Runs after backend deploy so
 * generated_from_service refs resolve from deployed_resources.url.
 */
export async function deployFrontendServices(runId: string): Promise<DeploySummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, defaultBranch } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const caps = await loadCapabilities(db, run.userId);
  const vault = getVault();

  const summary: DeploySummary = { deployed: [], failed: [], skipped: [] };
  const frontendTargets = plan.services.filter(
    (s) => s.type === "frontend_static" && s.provider === "vercel",
  );
  if (frontendTargets.length === 0) {
    await logger.log("No Vercel frontend_static services in plan.", { event: "deploy_skipped" });
    return summary;
  }

  await setStatus(db, runId, "deploying");
  await logger.stage("deploying", `Deploying ${frontendTargets.length} frontend service(s)`);

  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, run.userId));
  const accountByProvider = new Map(accounts.map((a) => [a.provider, a]));

  if (!adapters.has("vercel") || !accountByProvider.has("vercel")) {
    for (const s of frontendTargets) {
      summary.skipped.push({ id: s.id, reason: "vercel_not_connected" });
    }
    await logger.warn("Connect a Vercel API token to deploy the frontend.", {
      event: "deploy_needs_credential",
    });
    return summary;
  }

  const adapter = adapters.get("vercel");
  const vercelAccount = accountByProvider.get("vercel")!;
  const credValues = await decryptProviderCredentials(vault, vercelAccount);

  for (const svc of frontendTargets) {
    const types = caps.providers.get("vercel");
    if (!types?.has("frontend_static")) {
      summary.skipped.push({ id: svc.id, reason: "capability_missing" });
      continue;
    }

    const [existing] = await db
      .select()
      .from(deployedResources)
      .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, svc.id)))
      .limit(1);
    if (existing?.status === "live" && existing.url) {
      summary.skipped.push({ id: svc.id, reason: "already_deployed" });
      continue;
    }

    const deployedRows = await loadDeployedRows(db, runId);
    const { env, issues } = await resolveServiceEnv(svc, plan, deployedRows, vault);
    if (issues.length > 0) {
      summary.skipped.push({ id: svc.id, reason: issues[0]?.code ?? "env_unresolved" });
      await logger.warn(`Cannot deploy "${svc.id}": env resolution blocked.`, {
        event: "deploy_env_blocked",
        serviceId: svc.id,
        issues: issues.map((i) => i.code),
      });
      continue;
    }

    await logger.log(`Deploying frontend "${svc.id}" to Vercel`, {
      event: "deploy_started",
      serviceId: svc.id,
      provider: "vercel",
    });

    const deployLogs = chainedDeployOnLog(logger, svc.id);
    const result = await adapter.deploy({
      service: svc,
      repo: { fullName: repoFullName, branch: defaultBranch, commitSha: run.commitSha },
      rootDir: svc.rootDir,
      resourceName: `shipfix-${runId}-${svc.id}`.slice(0, 52),
      env,
      credentials: { provider: "vercel", values: credValues },
      onLog: deployLogs.onLog,
    });
    await deployLogs.flush();

    if (!result.ok || !result.publicUrl) {
      const kind = result.failureKind ?? "deploy_failed";
      summary.failed.push({ id: svc.id, kind });
      await db.insert(deployedResources).values({
        runId,
        serviceId: svc.id,
        kind: "service",
        provider: "vercel",
        externalId: result.externalId,
        url: result.publicUrl,
        status: "failed",
      });
      const setupMsg =
        kind === "setup_blocker"
          ? `Deploy blocked for "${svc.id}": provider account setup required.`
          : kind === "timeout"
            ? `Frontend "${svc.id}" deployment timed out on Vercel. Backend and database may still be live — check Vercel deployment logs or rerun Deploy.`
            : `Deploy failed for "${svc.id}".`;
      await logger.error(setupMsg, {
        event:
          kind === "setup_blocker"
            ? "deploy_setup_blocker"
            : kind === "timeout"
              ? "deploy_timeout"
              : "deploy_failed",
        serviceId: svc.id,
        provider: "vercel",
        failureKind: kind,
        vercelProjectId: result.externalId,
        detail: result.logs,
      });
      await emitRepoFixGuidance(logger, {
        repoFullName,
        service: svc,
        provider: "vercel",
        failureKind: kind,
        errorSummary: result.logs,
      });
      continue;
    }

    await db.insert(deployedResources).values({
      runId,
      serviceId: svc.id,
      kind: "service",
      provider: "vercel",
      externalId: result.externalId,
      url: result.publicUrl,
      status: "live",
    });

    summary.deployed.push(svc.id);
    await logger.log(`Frontend "${svc.id}" deployed`, {
      event: "service_deployed",
      serviceId: svc.id,
      provider: "vercel",
      serviceRole: "frontend",
      externalId: result.externalId,
      publicUrl: result.publicUrl,
    });
  }

  return summary;
}

export type { DeployRunOutcome, PlanVerifySummary, ProvisionSummary } from "./finalizeDeployRun";

/**
 * Plan-driven verification: backend health, frontend loads, CORS/wiring evidence.
 */
export async function verifyDeployedPlan(runId: string): Promise<PlanVerifySummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const plan = await loadPlan(db, runId);

  const summary: PlanVerifySummary = { passed: [], failed: [], skipped: [] };

  const rows = await db
    .select()
    .from(deployedResources)
    .where(and(eq(deployedResources.runId, runId), eq(deployedResources.kind, "service")));
  const live = rows.filter((r) => r.status === "live" && r.url);

  if (live.length === 0) {
    await logger.log("No deployed services to verify.", { event: "verify_skipped" });
    return summary;
  }

  if (plan.verification.length === 0) {
    await logger.log("Plan defines no verification checks.", { event: "verify_skipped" });
    return summary;
  }

  await setStatus(db, runId, "verifying");
  await logger.stage("verifying", `Running ${plan.verification.length} verification check(s)`);

  const outcomes = await verifyFromPlan(
    plan,
    live.map((r) => ({ serviceId: r.serviceId, publicUrl: r.url! })),
  );

  for (const o of outcomes) {
    const primary = o.results[0];
    if (o.skipped) {
      summary.skipped.push({
        serviceId: o.serviceId,
        check: o.check,
        reason: o.skipReason ?? "skipped",
      });
      await logger.warn(`Verification skipped: ${o.check} on "${o.serviceId}" (${o.skipReason})`, {
        event: "verification",
        check: o.check,
        serviceId: o.serviceId,
        ok: false,
        skipped: true,
        url: primary?.url ?? null,
      });
      continue;
    }
    await logger.log(
      `"${o.serviceId}" ${o.check}: ${o.ok ? "passed" : "failed"} (${primary?.detail ?? "unknown"})`,
      {
        event: "verification",
        check: o.check,
        serviceId: o.serviceId,
        ok: o.ok,
        statusCode: primary?.statusCode ?? null,
        url: primary?.url ?? null,
        assumedPath: o.assumedPath ?? false,
      },
    );
    if (o.ok) summary.passed.push({ serviceId: o.serviceId, check: o.check });
    else summary.failed.push({ serviceId: o.serviceId, check: o.check });
  }

  return summary;
}

/**
 * Terminal outcome for deploy mode. Full-stack `succeeded` only when every
 * supported service is deployed and every plan verification check passes.
 */
export async function finalizeDeployRun(runId: string, outcome: DeployRunOutcome): Promise<void> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const caps = await loadCapabilities(db, run.userId);

  const result = computeFinalizeDeployOutcome(plan, outcome, caps);
  await setStatus(db, runId, result.status, true);
  await logger.stage(result.status, result.message);
}

// ── Deploy-mode activities (intentionally unimplemented beyond this slice) ───

/** Full-system recovery wrapper — not this slice. */
export async function verifySystem(_runId: string): Promise<{ ok: boolean }> {
  return notImplemented("verifySystem");
}

/** Legacy finalize stub — deploy mode uses finalizeDeployRun. */
export async function finalize(_runId: string, _ok: boolean): Promise<void> {
  return notImplemented("finalize");
}
