import type {
  DeploymentPlan,
  ManagedKind,
  PlanClassification,
  PlanProvider,
  RepoContext,
  ServiceType,
  PlanService,
} from "@shipfix/contracts";
import { isWebBackendType } from "@shipfix/contracts";
import {
  analyzeRepo as runAnalyzer,
  repoSourceFromSandbox,
} from "@shipfix/analyzer";
import { createRunSandboxProvider } from "@shipfix/sandbox/runtime";
import { createSafePostgresSink, createRunLogger, type RunLogger } from "@shipfix/observability";
import { createLLMGateway } from "@shipfix/llm";
import { generatePlan as runPlanner } from "@shipfix/planner";
import {
  validatePlan as runValidator,
  capabilities as buildCapabilities,
  integrationProjectQuestionId,
  type Capabilities,
  type ManagedProvider,
} from "@shipfix/validator";
import {
  AdapterRegistry,
  preflightProviderCredentials,
  refreshOAuthCredentials,
  tailLines,
  type DeployFailureKind,
  type LogDiagnosis,
} from "@shipfix/adapter-core";
import { createRenderAdapter } from "@shipfix/adapter-render";
import { createVercelAdapter } from "@shipfix/adapter-vercel";
import {
  ProvisionerRegistry,
  createNeonProvisioner,
  createUpstashProvisioner,
  fetchSupabaseProjectValues,
  isRedisSecret,
  snapshotNeonDatabase,
  type ManagedProviderId,
} from "@shipfix/provisioner";
import { migrateSupabaseProject, type SupabaseMigrationOutcome } from "./supabaseMigrations";
import { verifyFromPlan, diagnosisFromVerifyOutcome, diagnosisForMigrationFailure, diagnosisForEnvUnresolved } from "@shipfix/verifier";
import { resolveServiceEnv, openManagedConnectionUrls, type DeployedResourceRow } from "./resolveEnv";
import {
  findPrismaSchemaPath,
  runPrismaMigrateDeploy,
} from "./prismaMigrate";
import {
  findDrizzleConfigPath,
  runDrizzleMigrateDeploy,
} from "./drizzleMigrate";
import { ensureGeneratedSecrets } from "./generatedSecrets";
import { resolveIntegrationValues, usedIntegrationIds, type IntegrationValuesResult } from "./integrationValues";
import { buildDeployFailureGuidance } from "./deployFailureGuidance";
import {
  findReusableManagedResource,
  resolveProviderDeployTarget,
  stableProviderResourceName,
} from "./providerResource";
import {
  computeFinalizeDeployOutcome,
  evaluateDeployGate,
  type DeployRunOutcome,
  type DeploySummary,
  type PlanVerifySummary,
  type ProvisionSummary,
} from "./finalizeDeployRun";
import { openOrUpdatePullRequest, pushCommitToBranch, resolveCloneToken, resolveRepoWriteToken } from "@shipfix/github";
import {
  applyPlanEdits,
  commitMessage,
  pullRequestBody,
  pullRequestTitle,
  runRepairLoop,
  unifiedDiffs,
  withSecurityHeaders,
  type FileEdit,
  type PlanEdit,
  type PullRequestFix,
} from "@shipfix/autofix";
import { sandboxRepairWorkspace } from "./repairWorkspace";
import { isSettingName, questionSatisfied, shouldWaitForInput, withMissingSettings, type MissingSetting } from "./inputWait";
import { createSecretVaultFromEnv, redact, type SecretVault } from "@shipfix/secrets";
import {
  createDb,
  llmUsage,
  runs,
  projects,
  plans,
  providerAccounts,
  deployedResources,
  runInputs,
  projectEnvVars,
  ownedGithubInstallationIds,
  type Database,
} from "@shipfix/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { LLMGateway, LLMRequest, LLMResult } from "@shipfix/llm";
import { failureEventForError, failureEventForMessage, unwrapFailureMessage } from "./errorMessages";
import { llmUsageLimitMessage, workflowAlphaLimit } from "./alphaLimits";
import {
  ControlPlaneConsistencyError,
  CONTROL_PLANE_CONSISTENCY_EVENT,
  controlPlaneConsistencyDetail,
  isControlPlaneConsistencyMessage,
  logWorkerControlPlaneMismatch,
} from "./controlPlaneConsistency";

/**
 * Temporal ACTIVITIES â€” the only side-effecting units.
 *
 * Activities (not the workflow) do I/O: sandbox, analyzer, DB, run-event sink.
 * They are individually retryable and isolated; the workflow stays deterministic
 * and just orchestrates them.
 *
 * Implemented: analyzeRepo + completeRun + failRun (analyze_only) and
 * proposePlan + finalizePlanRun (plan). Real deploy/provision/verify activities
 * remain explicit stubs â€” no fake capability.
 */

const notImplemented = (name: string): never => {
  throw new Error(`Activity "${name}" not implemented yet.`);
};

// â”€â”€ Lazily-initialized control-plane DB (one pool per worker process) â”€â”€â”€â”€â”€â”€â”€â”€
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
  status: string;
}

async function loadRun(
  db: Database,
  runId: string,
): Promise<{
  run: RunRow;
  repoFullName: string;
  defaultBranch: string;
  githubInstallationId: string | null;
  /** What providers build: the verified fix branch once ShipFix pushed one, else the default branch at the run's commit. */
  deployRef: { branch: string; commitSha: string };
}> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) {
    throw new ControlPlaneConsistencyError(runId, controlPlaneConsistencyDetail(runId));
  }
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .limit(1);
  if (!project) throw new Error(`Project ${run.projectId} for run ${runId} not found.`);
  return {
    run: { id: run.id, projectId: run.projectId, userId: project.userId, commitSha: run.commitSha, mode: run.mode, status: run.status },
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
    githubInstallationId: project.githubInstallationId ?? null,
    deployRef:
      run.deployBranch && run.deploySha
        ? { branch: run.deployBranch, commitSha: run.deploySha }
        : { branch: project.defaultBranch, commitSha: run.commitSha },
  };
}

// â”€â”€ Registries + vault (one per worker process) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const provisioners = new ProvisionerRegistry();
provisioners.register(createNeonProvisioner());
provisioners.register(createUpstashProvisioner());

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

/**
 * Defer gateway construction until the first model call. Deterministic plan
 * synthesis never touches the LLM, so a slice-matching repo can be planned even
 * with no LLM configured (and consumes no LLM usage).
 */
export function lazyGateway(make: () => LLMGateway): LLMGateway {
  let inner: LLMGateway | null = null;
  const get = (): LLMGateway => (inner ??= make());
  return {
    get model() {
      return get().model;
    },
    complete: (req) => get().complete(req),
  };
}

const REPAIR_OPERATION = "repair";

export function meteredGateway(
  inner: LLMGateway,
  db: Database,
  meta: { userId: string; projectId: string; runId: string; operation: string },
): LLMGateway {
  const provider = providerFromEnv();
  return {
    model: inner.model,
    async complete(req: LLMRequest): Promise<LLMResult> {
      // Repair has its own per-run budget so planning can't starve it (and vice versa).
      const isRepair = meta.operation === REPAIR_OPERATION;
      const maxPerRun = workflowAlphaLimit(isRepair ? "ALPHA_MAX_REPAIR_LLM_CALLS_PER_RUN" : "ALPHA_MAX_LLM_CALLS_PER_RUN");
      const maxPerUserDay = workflowAlphaLimit("ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY");
      const runCalls = await countLlmAttemptRows(
        db,
        and(
          eq(llmUsage.runId, meta.runId),
          isRepair ? eq(llmUsage.operation, REPAIR_OPERATION) : sql`${llmUsage.operation} <> ${REPAIR_OPERATION}`,
        ),
      );
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

/** Non-secret provider dashboard URL for UI deep links. */
function providerConsoleUrl(
  provider: string,
  externalId: string | null | undefined,
  opts?: { resourceName?: string; teamId?: string },
): string | null {
  if (!externalId) return null;
  const id = encodeURIComponent(externalId);
  if (provider === "render") return `https://dashboard.render.com/web/${id}`;
  if (provider === "neon") return `https://console.neon.tech/app/projects/${id}`;
  if (provider === "upstash") return `https://console.upstash.com/redis/${id}`;
  if (provider === "vercel") {
    const team = opts?.teamId?.trim();
    const name = opts?.resourceName?.trim();
    if (team && name) {
      return `https://vercel.com/${encodeURIComponent(team)}/${encodeURIComponent(name)}`;
    }
  }
  return null;
}

function resourceMeta(args: {
  provider: string;
  externalId: string | null | undefined;
  resourceName?: string;
  teamId?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const consoleUrl = providerConsoleUrl(args.provider, args.externalId, {
    resourceName: args.resourceName,
    teamId: args.teamId,
  });
  return {
    ...(args.resourceName ? { resourceName: args.resourceName } : {}),
    ...(consoleUrl ? { consoleUrl } : {}),
    ...(args.extra ?? {}),
  };
}

/** What the repair loop needs from a failed deploy. Logs are already scrubbed of env values by the adapter. */
function failureMeta(kind: DeployFailureKind, logs: string | undefined, diagnosis: LogDiagnosis | undefined): Record<string, unknown> {
  return {
    failureKind: kind,
    ...(diagnosis ? { diagnosis } : {}),
    ...(logs ? { failureLog: redact(tailLines(logs.split(/\r?\n/), 200, 16_000)) } : {}),
  };
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
 * Real system capabilities = registered providers âˆ© the credentials this user
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

  return buildCapabilities(providerServiceTypes, managed, connected.has("supabase") ? ["supabase"] : []);
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
    reused: Boolean((r.meta as { reusedFromRunId?: unknown } | null)?.reusedFromRunId),
    provider: r.provider,
    externalId: r.externalId,
  }));
}

/** Open run_inputs for env resolution. Values must never be logged. */
async function loadRunInputValues(
  db: Database,
  runId: string,
  vault: SecretVault,
): Promise<Map<string, string>> {
  const rows = await db.select().from(runInputs).where(eq(runInputs.runId, runId));
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.isSecret) {
      if (!row.encBlob || !row.encIv || !row.encDek) continue;
      const value = await vault.open({
        encBlob: row.encBlob,
        encIv: row.encIv,
        encDek: row.encDek,
      });
      if (value) map.set(row.questionId, value);
    } else if (row.valuePlain) {
      map.set(row.questionId, row.valuePlain);
    }
  }
  return map;
}

/**
 * Open durable project env vars keyed by name, first creating any
 * `generated_secret` values the plan needs. Values must never be logged.
 */
async function loadProjectEnvValues(
  db: Database,
  projectId: string,
  vault: SecretVault,
  plan: DeploymentPlan,
): Promise<Map<string, string>> {
  await ensureGeneratedSecrets(db, projectId, plan, vault);
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId));
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.isSecret) {
      if (!row.encBlob || !row.encIv || !row.encDek) continue;
      const value = await vault.open({
        encBlob: row.encBlob,
        encIv: row.encIv,
        encDek: row.encDek,
      });
      if (value) map.set(row.name, value);
    } else if (row.valuePlain) {
      map.set(row.name, row.valuePlain);
    }
  }
  return map;
}

/**
 * Read env values from connected integrations (e.g. the app's Supabase
 * project) for the plan. Values must never be logged; problems are user-safe.
 */
async function loadIntegrationValues(
  db: Database,
  userId: string,
  plan: DeploymentPlan,
  vault: SecretVault,
  runInputValues: ReadonlyMap<string, string>,
): Promise<IntegrationValuesResult> {
  if (usedIntegrationIds(plan).size === 0) return { values: new Map(), problems: [] };
  const accounts = await db.select().from(providerAccounts).where(eq(providerAccounts.userId, userId));
  const credentials = new Map<string, Record<string, string>>();
  for (const a of accounts) {
    if (a.provider === "supabase") credentials.set(a.provider, await decryptProviderCredentials(vault, a));
  }
  return resolveIntegrationValues(plan, credentials, runInputValues);
}

/** Integration env names the user has not overridden on the project. */
function integrationEnvStillNeeded(plan: DeploymentPlan, projectEnvValues: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const s of plan.services) {
    for (const e of s.env) if (e.source === "integration" && !projectEnvValues.get(e.name)) names.add(e.name);
  }
  return [...names];
}

/**
 * On a deploy failure, emit structured next-step guidance (credentials vs repo
 * vs provider limit, etc.). ShipFix never mutates the repo.
 */
async function emitDeployFailureGuidance(
  logger: RunLogger,
  args: {
    repoFullName: string;
    service: PlanService;
    provider: string;
    failureKind: DeployFailureKind;
    errorSummary: string;
    diagnosis?: LogDiagnosis;
  },
): Promise<void> {
  const guidance = buildDeployFailureGuidance({
    repoFullName: args.repoFullName,
    service: args.service,
    provider: args.provider,
    failureKind: args.failureKind,
    errorSummary: args.errorSummary,
    ...(args.diagnosis ? { diagnosis: args.diagnosis } : {}),
  });
  await logger.warn(guidance.whatHappened, {
    event: "deploy_failure_guidance",
    serviceId: guidance.serviceId,
    provider: guidance.provider,
    failureKind: guidance.failureKind,
    action: guidance.action,
    stage: guidance.stage,
    title: guidance.title,
    whatHappened: guidance.whatHappened,
    whatYouShouldDo: guidance.whatYouShouldDo,
    showCursorPrompt: guidance.showCursorPrompt,
    ...(guidance.fixPrompt ? { fixPrompt: guidance.fixPrompt } : {}),
    ...(args.diagnosis
      ? {
          diagnosis: {
            kind: args.diagnosis.kind,
            phase: args.diagnosis.phase,
            subject: args.diagnosis.subject,
            fixOwner: args.diagnosis.fixOwner,
            evidence: args.diagnosis.evidence,
          },
        }
      : {}),
  });
}

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

function planHasUnsupportedServices(plan: DeploymentPlan, caps: Capabilities): boolean {
  for (const svc of plan.services) {
    const types = caps.providers.get(svc.provider);
    if (!types?.has(svc.type)) return true;
  }
  return false;
}

async function decryptProviderCredentials(
  vault: SecretVault,
  account: { id?: string; provider?: string; encDek: Buffer; encBlob: Buffer; encIv: Buffer },
): Promise<Record<string, string>> {
  const values = JSON.parse(
    await vault.open({ encDek: account.encDek, encBlob: account.encBlob, encIv: account.encIv }),
  ) as Record<string, string>;
  if (!account.id || !account.provider || !values.refreshToken) return values;
  const refreshed = await refreshOAuthCredentials(account.provider, values);
  if (!refreshed.rotated) return values;
  try {
    const sealed = await vault.seal(JSON.stringify(refreshed.values));
    await getDb()
      .update(providerAccounts)
      .set({ encDek: sealed.encDek, encBlob: sealed.encBlob, encIv: sealed.encIv })
      .where(eq(providerAccounts.id, account.id));
  } catch {
    // Use the fresh token for this attempt even if the new ciphertext could not be saved.
  }
  return refreshed.values;
}

async function setStatus(
  db: Database,
  runId: string,
  status: string,
  finished = false,
): Promise<void> {
  const patch: { status: string; finishedAt?: Date; costCents?: number } = { status };
  if (finished) {
    const rows = await db
      .select({ total: sql<number>`coalesce(sum(${llmUsage.estimatedCostCents}), 0)` })
      .from(llmUsage)
      .where(eq(llmUsage.runId, runId));
    const total = Number(rows[0] && "total" in rows[0] ? rows[0].total : 0);
    patch.finishedAt = new Date();
    patch.costCents = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
  }
  await db.update(runs).set(patch).where(eq(runs.id, runId));
}

/** One branch per run for the header pull request, separate from a deploy-fix branch. */
export function securityBranchName(runId: string): string {
  return `shipfix/security-${runId.slice(0, 8)}`;
}

/**
 * When a deploy is missing basic response headers, push vercel.json on a
 * ShipFix branch and open a pull request. The default branch is not changed.
 * Without GitHub write access the finding stays on the report.
 */
async function offerSecurityHeaderPullRequest(
  db: Database,
  logger: RunLogger,
  sandbox: { readFile(path: string): Promise<string> },
  args: {
    runId: string;
    userId: string;
    mode: string;
    repoFullName: string;
    baseBranch: string;
    baseSha: string;
    githubInstallationId: string | null;
    security: RepoContext["security"];
  },
): Promise<void> {
  const finding = args.security?.findings.find((f) => f.code === "missing_headers" && f.fixable);
  if (!finding || args.mode !== "deploy") return;
  let raw: string | null = null;
  try {
    raw = await sandbox.readFile("vercel.json");
  } catch {
    raw = null;
  }
  const next = withSecurityHeaders(raw);
  if (!next?.changed) return;
  const scope = {
    repoFullName: args.repoFullName,
    installationId: args.githubInstallationId,
    allowedInstallationIds: await ownedGithubInstallationIds(db, args.userId),
  };
  const token =
    (await resolveRepoWriteToken({ ...scope, permissions: { contents: "write", pull_requests: "write" } })) ??
    (await resolveRepoWriteToken(scope));
  if (!token) {
    await logger.log(
      "Security headers are missing. Connect GitHub with write access and ShipFix will open a pull request to add them.",
      { event: "security_fix_unpushed" },
    );
    return;
  }
  const branch = securityBranchName(args.runId);
  const pushed = await pushCommitToBranch({
    token,
    repoFullName: args.repoFullName,
    baseSha: args.baseSha,
    branch,
    message: "Add security headers\n\nThe frontend responses were not setting basic browser protections.\n\nFixed by ShipFix",
    changes: [{ path: "vercel.json", content: next.content }],
  });
  if (!pushed.ok) {
    await logger.warn("ShipFix found missing security headers but could not push the fix.", {
      event: "security_fix_unpushed",
      error: pushed.error,
    });
    return;
  }
  const pr = await openOrUpdatePullRequest({
    token,
    repoFullName: args.repoFullName,
    head: branch,
    base: args.baseBranch,
    title: "ShipFix: add security headers",
    body: [
      "ShipFix checked this repo and the frontend responses do not set basic security headers.",
      "## What changed\n\n- `vercel.json` sends `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `Strict-Transport-Security` on every path.",
      "## Keeping or undoing it\n\n- **Merge** to keep the headers.\n- **Close** to leave responses as they are.",
      "---\nFixed by ShipFix",
    ].join("\n\n"),
  });
  if (!pr.ok) {
    await logger.warn("ShipFix pushed the header fix but could not open the pull request.", {
      event: "security_fix_unpushed",
      branch,
      error: pr.error,
    });
    return;
  }
  await logger.log(`Opened a pull request adding security headers: ${pr.url}`, {
    event: "security_pr",
    url: pr.url,
    branch,
  });
}

/**
 * Clone in a (DEV) sandbox + run deterministic static analysis -> RepoContext.
 * Emits the analyze_only event timeline as it goes; the final RepoContext rides
 * on the `analysis_completed` event so the UI can render it without a new table.
 */
export async function analyzeRepo(runId: string): Promise<RepoContext> {
  const db = getDb();
  const logger: RunLogger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, defaultBranch, githubInstallationId } = await loadRun(db, runId);

  await setStatus(db, runId, "analyzing");
  await logger.stage("analyzing", `Analyzing ${repoFullName}`);

  const provider = createRunSandboxProvider();
  const sandbox = await provider.create({ runId });

  try {
    await logger.log("Cloning repository", {
      event: "repo_clone_started",
      repoFullName,
    });
    const token = await resolveCloneToken({
      repoFullName,
      installationId: githubInstallationId,
      allowedInstallationIds: await ownedGithubInstallationIds(db, run.userId),
    });
    await sandbox.clone({ repoFullName, sha: run.commitSha, token });

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

    await logger.log(`Launch readiness ${ctx.security?.score ?? 100}/100`, {
      event: "security_scanned",
      score: ctx.security?.score ?? 100,
      findings: (ctx.security?.findings ?? []).map((f) => f.code),
    });
    try {
      await offerSecurityHeaderPullRequest(db, logger, sandbox, {
        runId,
        userId: run.userId,
        mode: run.mode,
        repoFullName,
        baseBranch: defaultBranch,
        baseSha: commitSha,
        githubInstallationId,
        security: ctx.security,
      });
    } catch (err) {
      await logger.warn("The security-header pull request could not be opened.", {
        event: "security_fix_unpushed",
        error: err instanceof Error ? err.message : String(err),
      });
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
  const [existing] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!existing) {
    logWorkerControlPlaneMismatch(runId, message);
    return;
  }

  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const liveResources = (
    await db.select({ status: deployedResources.status }).from(deployedResources).where(eq(deployedResources.runId, runId))
  ).filter((r) => r.status === "live").length;

  // Live infrastructure (e.g. a provisioned database, a deployed backend) is useful
  // evidence even when a later step broke, so the honest terminal state is
  // "diagnosed", not "failed".
  if (liveResources > 0 && !isControlPlaneConsistencyMessage(message)) {
    await setStatus(db, runId, "diagnosed", true);
    const failure = failureEventForMessage(message);
    await logger.error(failure.title, { event: failure.event, message, liveResources });
    await logger.stage(
      "diagnosed",
      `${liveResources} resource(s) are live, but the deploy did not finish: ${message}`,
    );
    return;
  }

  await setStatus(db, runId, "failed", true);

  if (isControlPlaneConsistencyMessage(message)) {
    await logger.error(
      "ShipFix started a worker task, but the worker could not find the run record. This usually means API and worker are connected to different databases.",
      {
        event: CONTROL_PLANE_CONSISTENCY_EVENT,
        runId,
        message,
      },
    );
    return;
  }

  const failure = failureEventForMessage(message);
  await logger.error(failure.title, { event: failure.event, message });
}

/**
 * Boundary marker between static analysis and plan generation. This makes the
 * analyze -> plan handoff visible even if the planner activity fails before it
 * can write its own event.
 */
export async function startPlanTransition(runId: string): Promise<void> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  await loadRun(db, runId);
  await setStatus(db, runId, "planning");
  await logger.stage("planning", "Starting deployment plan generation");
  await logger.log("Starting deployment plan generation", {
    event: "planning_started",
    fromEvent: "analysis_completed",
  });
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
  await logger.log("Generating a deployment plan from the analysis", {
    event: "plan_generation_started",
    serviceCount: ctx.services.length,
    dataNeedCount: ctx.dataNeeds.length,
  });

  let result: Awaited<ReturnType<typeof runPlanner>>;
  try {
    // Lazy: repos planned deterministically never touch the model, so they
    // must not require LLM config or consume LLM usage. The LLM path still
    // throws a clear, actionable error if backend-owned env vars are unset â€”
    // we never fall back to a mock planner.
    const gateway = lazyGateway(() =>
      meteredGateway(createLLMGateway(), db, {
        userId: run.userId,
        projectId: run.projectId,
        runId,
        operation: "plan",
      }),
    );
    result = await runPlanner(ctx, gateway);
  } catch (err) {
    const message = unwrapFailureMessage(err);
    // Classify from the typed error first: a provider 429/503 must surface as
    // "AI planner temporarily unavailable", never as a ShipFix usage limit.
    const classified = failureEventForError(err);
    const failure =
      classified.event === "planning_failed"
        ? { ...classified, event: "internal_plan_generation_failed" as const, title: "Plan generation failed inside ShipFix" }
        : classified;
    await logger.error(failure.title, {
      event: failure.event,
      operation: "plan",
      message,
    });
    throw new Error(message);
  }

  await logger.log("Deployment plan generated", {
    event: "plan_generation_completed",
    model: result.model,
    usedFallback: result.usedFallback,
    planSource: result.planSource,
    proposedClassification: result.plan.classification,
  });

  await logger.log(
    `Proposed plan: ${result.plan.classification}, ${result.plan.services.length} service(s), ${result.plan.managed.length} managed`,
    {
      event: "plan_generated",
      model: result.model,
      usedFallback: result.usedFallback,
      planSource: result.planSource,
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
      "Deployment is not available in this build â€” the validator downgraded the plan. It is delivered as a diagnosis/preview.",
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
    await logger.stage("diagnosed", "Deployment not available in this build â€” diagnosis ready");
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

  // C2: flip Yellowâ†’Green when secrets/project env are already answered.
  try {
    const { revalidatePlanForRun } = await import("./revalidatePlan");
    const rev = await revalidatePlanForRun(db, runId);
    if (rev.changed) {
      await logger.log("Plan revalidated before deploy gate", {
        event: "plan_revalidated",
        classification: rev.classification,
      });
    }
  } catch {
    /* proceed with stored plan */
  }

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

  // Credential preflight: prove every required provider token is still
  // accepted BEFORE any resource is created. A revoked token fails here in
  // seconds as a clear setup blocker, not after a ten-minute deploy attempt.
  if (gate.allow) {
    const { run } = await loadRun(db, runId);
    const usesIntegrations = usedIntegrationIds(plan).size > 0;
    const requiredProviders = new Set<string>([
      ...plan.services.map((s) => s.provider),
      ...plan.managed.filter((m) => m.mode === "provision" && m.provider).map((m) => m.provider!),
      ...(usesIntegrations ? (plan.integrations ?? []).map((i) => i.provider) : []),
    ]);
    const accounts = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.userId, run.userId));
    const accountByProvider = new Map(accounts.map((a) => [a.provider, a]));
    const vault = getVault();

    for (const provider of requiredProviders) {
      const account = accountByProvider.get(provider);
      if (!account) continue; // missing connection is reported by the deploy steps
      const values = await decryptProviderCredentials(vault, account);
      const preflight = await preflightProviderCredentials(provider, values);
      if (!preflight.ok) {
        const message =
          preflight.message ??
          `The connected ${provider} credential was rejected. Reconnect the account and rerun deploy.`;
        await logger.error(message, {
          event: "deploy_setup_blocker",
          provider,
          failureKind: "setup_blocker",
          code: "credential_rejected",
        });
        await setStatus(db, runId, "diagnosed", true);
        await logger.stage(
          "diagnosed",
          `Deploy not started â€” the ${provider} credential was rejected. Reconnect the account and rerun deploy.`,
        );
        return { allow: false };
      }
    }

    // Read the existing project's values now, so a wrong or missing project
    // fails before any resource exists rather than mid-deploy.
    if (usesIntegrations) {
      const runInputValues = await loadRunInputValues(db, runId, vault);
      const projectEnvValues = await loadProjectEnvValues(db, run.projectId, vault, plan);
      const stillNeeded = integrationEnvStillNeeded(plan, projectEnvValues);
      if (stillNeeded.length > 0) {
        const { values, problems } = await loadIntegrationValues(db, run.userId, plan, vault, runInputValues);
        const missing = plan.services.flatMap((s) =>
          s.env.filter((e) => e.source === "integration" && stillNeeded.includes(e.name) && !values.has(e.ref ?? "")),
        );
        if (missing.length > 0) {
          const message =
            problems[0] ??
            `Your connected Supabase project did not provide ${[...new Set(missing.map((e) => e.name))].join(", ")}. Set them on the app, then rerun deploy.`;
          await logger.error(message, {
            event: "deploy_setup_blocker",
            provider: "supabase",
            failureKind: "setup_blocker",
            code: "integration_unavailable",
          });
          await setStatus(db, runId, "diagnosed", true);
          await logger.stage("diagnosed", `Deploy not started — ${message}`);
          return { allow: false };
        }
      }
    }
    return { allow: true };
  }

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
      await logger.warn(`No provisioner registered for "${m.provider}" â€” skipping ${m.id}.`, {
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

    const previous = await findReusableManagedResource(db, {
      projectId: run.projectId,
      serviceId: m.id,
      provider: m.provider,
      excludeRunId: runId,
    });
    if (previous) {
      const exposed = {
        name: previous.exposesEnv || m.exposesEnv || "DATABASE_URL",
        value: await vault.open({
          encDek: previous.encDek!,
          encBlob: previous.encBlob!,
          encIv: previous.encIv!,
        }),
      };
      const reuseVerdict = await provisioner.verify(exposed);
      if (reuseVerdict.ok) {
        await db.insert(deployedResources).values({
          runId,
          serviceId: m.id,
          kind: previous.kind,
          provider: m.provider,
          externalId: previous.externalId,
          url: previous.url,
          status: "live",
          exposesEnv: exposed.name,
          encBlob: previous.encBlob,
          encIv: previous.encIv,
          encDek: previous.encDek,
          meta: {
            ...resourceMeta({ provider: m.provider, externalId: previous.externalId }),
            reusedFromRunId: previous.runId,
          },
        });
        summary.provisioned.push(m.id);
        await logger.log(`Reusing existing ${m.kind} for "${m.id}" (data preserved)`, {
          event: "resource_reused",
          managedId: m.id,
          provider: m.provider,
          kind: m.kind,
          externalId: previous.externalId,
          host: previous.url,
          reusedFromRunId: previous.runId,
        });
        await logger.log(`Verification for "${m.id}": reachable`, {
          event: "verification",
          check: "db_connect",
          managedId: m.id,
          ok: true,
          detail: reuseVerdict.detail,
        });
        continue;
      }
      await logger.warn(
        `Previous ${m.kind} for "${m.id}" is no longer reachable; provisioning a new one.`,
        { event: "resource_reuse_failed", managedId: m.id, externalId: previous.externalId, detail: reuseVerdict.detail },
      );
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
      resourceName: stableProviderResourceName(run.projectId, m.id),
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
        meta: resourceMeta({ provider: m.provider, externalId: result.externalId }),
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
      ...(verdict.ok
        ? {}
        : {
            diagnosis: {
              code: "db_unreachable" as const,
              managedId: m.id,
              serviceId: m.id,
              evidence: { detail: verdict.detail },
              action:
                m.kind === "redis"
                  ? `Confirm the Upstash database is active and ${m.exposesEnv} is wired to the app, then retry deploy.`
                  : `Confirm the Neon project is live and ${m.exposesEnv} is wired to the backend, then retry deploy.`,
            },
          }),
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
        meta: resourceMeta({ provider: m.provider, externalId: result.externalId }),
      });
      await logger.error(`${m.kind === "redis" ? "Redis" : "Database"} verification failed for "${m.id}".`, verifyPayload);
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
      meta: resourceMeta({ provider: m.provider, externalId: result.externalId }),
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

export interface MigrationSummary {
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: string[];
}

/**
 * Branch a reused Neon database before migrating it, so the user can roll
 * back. Freshly created databases are empty and are not snapshotted. A failed
 * snapshot is reported but does not block the migration.
 */
async function snapshotBeforeMigrate(
  db: Database,
  userId: string,
  row: DeployedResourceRow,
  managedId: string,
  logger: RunLogger,
  vault: SecretVault,
): Promise<void> {
  if (row.provider !== "neon" || !row.externalId) return;
  const [account] = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.provider, "neon")))
    .limit(1);
  const apiKey = account ? (await decryptProviderCredentials(vault, account)).apiKey : undefined;
  const result = apiKey
    ? await snapshotNeonDatabase(apiKey, row.externalId)
    : { ok: false as const, message: "Neon is not connected." };
  if (result.ok) {
    await logger.log(`Snapshot branch "${result.branchName}" created before migrating "${managedId}".`, {
      event: "db_snapshot_created",
      managedId,
      provider: "neon",
      branch: result.branchName,
      prunedSnapshots: result.pruned,
    });
  } else {
    await logger.warn(`Could not snapshot "${managedId}" before migrating: ${result.message}`, {
      event: "db_snapshot_failed",
      managedId,
      provider: "neon",
    });
  }
}

/**
 * Run managed DB migrations after provision and before service deploy.
 * Prisma and Drizzle: use Neon **direct** URL inside the sandbox.
 * Runtime services still receive the **pooled** URL via resolveEnv.
 */
export async function runManagedMigrations(runId: string): Promise<MigrationSummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, githubInstallationId } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const vault = getVault();
  const summary: MigrationSummary = { applied: [], skipped: [], failed: [] };

  const atStart = plan.managed.filter((m) => m.migration === "django" || m.migration === "alembic");
  if (atStart.length > 0) {
    const rows = await loadDeployedRows(db, runId);
    for (const m of atStart) {
      const row = rows.find((r) => r.serviceId === m.id && r.status === "live");
      if (row?.reused) await snapshotBeforeMigrate(db, run.userId, row, m.id, logger, vault);
      await logger.log(`"${m.id}" ${m.migration} migrations run when the backend service starts.`, {
        event: "migration_at_start",
        managedId: m.id,
        tool: m.migration,
      });
    }
  }

  const targets = plan.managed.filter((m) => m.migration === "prisma" || m.migration === "drizzle");
  if (targets.length === 0) {
    await logger.log("No managed migrations to run.", { event: "migration_skipped" });
    return summary;
  }

  await setStatus(db, runId, "provisioning");
  await logger.stage("provisioning", `Running database migrations (${targets.length})`);

  const deployedRows = await loadDeployedRows(db, runId);
  const preferredRoot =
    plan.services.find((s) => s.type === "node_api")?.rootDir ??
    plan.services.find((s) => s.type === "frontend_ssr")?.rootDir ??
    "";
  const packageManager =
    plan.services.find((s) => s.type === "node_api")?.install?.split(/\s+/)[0] ??
    plan.services.find((s) => s.type === "frontend_ssr")?.install?.split(/\s+/)[0] ??
    "npm";

  const dbHosts: string[] = [];
  for (const m of targets) {
    const row = deployedRows.find((r) => r.serviceId === m.id && r.status === "live");
    const urls = row ? await openManagedConnectionUrls(row, vault) : null;
    if (!urls) continue;
    for (const raw of [urls.pooled, urls.direct]) {
      try {
        if (raw) dbHosts.push(new URL(raw).hostname);
      } catch {
        /* unparseable URLs are reported by the migration step itself */
      }
    }
  }

  const provider = createRunSandboxProvider();
  const sandbox = await provider.create({ runId: `${runId}-migrate`, egressAllow: dbHosts });

  try {
    const token = await resolveCloneToken({
      repoFullName,
      installationId: githubInstallationId,
      allowedInstallationIds: await ownedGithubInstallationIds(db, run.userId),
    });
    await sandbox.clone({ repoFullName, sha: run.commitSha, token });
    const files = await sandbox.list();

    for (const m of targets) {
      const row = deployedRows.find((r) => r.serviceId === m.id && r.status === "live");
      if (!row) {
        summary.failed.push(m.id);
        await logger.error(`Cannot migrate "${m.id}": managed database is not live.`, {
          event: "migration_failed",
          managedId: m.id,
          reason: "managed_not_live",
          diagnosis: diagnosisForMigrationFailure({ managedId: m.id, reason: "managed_not_live" }),
        });
        continue;
      }

      const urls = await openManagedConnectionUrls(row, vault);
      if (!urls) {
        summary.failed.push(m.id);
        await logger.error(`Cannot migrate "${m.id}": sealed connection missing.`, {
          event: "migration_failed",
          managedId: m.id,
          reason: "secret_missing",
          diagnosis: diagnosisForMigrationFailure({ managedId: m.id, reason: "secret_missing" }),
        });
        continue;
      }

      const tool = m.migration === "drizzle" ? "drizzle" : "prisma";
      if (row.reused) await snapshotBeforeMigrate(db, run.userId, row, m.id, logger, vault);
      let result: { ok: boolean; skipped: boolean; skipReason?: string; detail: string };

      if (tool === "drizzle") {
        const configPath = findDrizzleConfigPath(files, preferredRoot || undefined);
        if (!configPath) {
          summary.failed.push(m.id);
          await logger.error(`Cannot migrate "${m.id}": no drizzle.config found in the repo.`, {
            event: "migration_failed",
            managedId: m.id,
            reason: "schema_missing",
            diagnosis: diagnosisForMigrationFailure({ managedId: m.id, reason: "schema_missing" }),
          });
          continue;
        }
        await logger.log(`Running drizzle-kit migrate for "${m.id}"`, {
          event: "migration_started",
          managedId: m.id,
          tool: "drizzle",
          configPath,
        });
        result = await runDrizzleMigrateDeploy({
          sandbox,
          configPath,
          packageManager,
          urls,
          freshDatabase: !row.reused,
        });
      } else {
        const schemaPath = findPrismaSchemaPath(files, preferredRoot || undefined);
        if (!schemaPath) {
          summary.failed.push(m.id);
          await logger.error(`Cannot migrate "${m.id}": no schema.prisma found in the repo.`, {
            event: "migration_failed",
            managedId: m.id,
            reason: "schema_missing",
            diagnosis: diagnosisForMigrationFailure({ managedId: m.id, reason: "schema_missing" }),
          });
          continue;
        }
        await logger.log(`Running Prisma migrate deploy for "${m.id}"`, {
          event: "migration_started",
          managedId: m.id,
          tool: "prisma",
          schemaPath,
        });
        result = await runPrismaMigrateDeploy({
          sandbox,
          schemaPath,
          packageManager,
          urls,
          freshDatabase: !row.reused,
        });
      }

      if (result.skipped) {
        summary.skipped.push({ id: m.id, reason: result.skipReason ?? "skipped" });
        await logger.log(`Migration skipped for "${m.id}": ${result.detail}`, {
          event: "migration_skipped",
          managedId: m.id,
          reason: result.skipReason,
        });
        continue;
      }

      if (!result.ok) {
        summary.failed.push(m.id);
        await logger.error(`Migration failed for "${m.id}".`, {
          event: "migration_failed",
          managedId: m.id,
          tool,
          detail: result.detail,
          diagnosis: diagnosisForMigrationFailure({
            managedId: m.id,
            reason: "command_failed",
            detail: result.detail,
          }),
        });
        continue;
      }

      summary.applied.push(m.id);
      const [existing] = await db
        .select()
        .from(deployedResources)
        .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, m.id)))
        .limit(1);
      if (existing) {
        const prevMeta =
          existing.meta && typeof existing.meta === "object" && !Array.isArray(existing.meta)
            ? (existing.meta as Record<string, unknown>)
            : {};
        await db
          .update(deployedResources)
          .set({
            meta: { ...prevMeta, migrationsApplied: true, migrationTool: tool },
          })
          .where(eq(deployedResources.id, existing.id));
      }
      await logger.log(`Migrations applied for "${m.id}"`, {
        event: "migration_completed",
        managedId: m.id,
        tool,
      });
    }
  } finally {
    await sandbox.dispose();
  }

  if (summary.failed.length > 0) {
    throw new Error(
      `Database migrations failed for ${summary.failed.join(", ")}. Deploy was not started.`,
    );
  }

  return summary;
}

/**
 * Bring the app's existing Supabase project up to date with the repo's
 * supabase/migrations (pending tail only, restore point first), then check
 * which public tables still have row-level security off. A failed migration
 * stops the deploy; migrations ShipFix judged unsafe are reported and skipped.
 */
export async function applySupabaseMigrations(runId: string): Promise<SupabaseMigrationOutcome | null> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, githubInstallationId } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const integration = (plan.integrations ?? []).find((i) => i.provider === "supabase");
  if (!integration) return null;

  const vault = getVault();
  const [account] = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, run.userId), eq(providerAccounts.provider, "supabase")))
    .limit(1);
  const token = account ? (await decryptProviderCredentials(vault, account)).accessToken?.trim() : undefined;
  if (!token) {
    if (integration.migrations?.length) {
      await logger.warn("Connect Supabase so ShipFix can apply your pending migrations.", {
        event: "supabase_migrations_skipped",
        reason: "not_connected",
      });
    }
    return null;
  }
  const runInputValues = await loadRunInputValues(db, runId, vault);
  const lookup = await fetchSupabaseProjectValues(
    token,
    integration.projectRef ?? runInputValues.get(integrationProjectQuestionId(integration.id))?.trim() ?? null,
  );
  if (!lookup.ok) {
    await logger.warn(`Supabase migrations not checked: ${lookup.message}`, {
      event: "supabase_migrations_skipped",
      reason: lookup.code,
    });
    return null;
  }
  const ref = lookup.values.projectRef;
  const migrations = integration.migrations ?? [];
  if (migrations.length) {
    await logger.stage("provisioning", `Checking ${migrations.length} Supabase migration(s) against project ${ref}`);
  }

  let sandbox: Awaited<ReturnType<ReturnType<typeof createRunSandboxProvider>["create"]>> | null = null;
  const readFile = async (path: string): Promise<string | null> => {
    if (!sandbox) {
      sandbox = await createRunSandboxProvider().create({ runId: `${runId}-supabase`, egressAllow: [] });
      const cloneToken = await resolveCloneToken({
        repoFullName,
        installationId: githubInstallationId,
        allowedInstallationIds: await ownedGithubInstallationIds(db, run.userId),
      });
      await sandbox.clone({ repoFullName, sha: run.commitSha, token: cloneToken });
    }
    return sandbox.readFile(path).catch(() => null);
  };

  let outcome: SupabaseMigrationOutcome;
  try {
    outcome = await migrateSupabaseProject(migrations, {
      token,
      ref,
      readFile,
      restorePointName: `shipfix-${Date.now().toString(36)}`,
    });
  } finally {
    if (sandbox) await (sandbox as { dispose: () => Promise<void> }).dispose();
  }

  if (outcome.restorePoint) {
    await logger.log(`Created Supabase restore point "${outcome.restorePoint}" before migrating.`, {
      event: "supabase_restore_point",
      restorePoint: outcome.restorePoint,
    });
  }
  if (outcome.applied.length) {
    await logger.log(`Applied ${outcome.applied.length} Supabase migration(s): ${outcome.applied.join(", ")}`, {
      event: "migration_completed",
      tool: "supabase",
      versions: outcome.applied,
    });
  } else if (migrations.length && !outcome.skipped && !outcome.failed) {
    await logger.log("Supabase migrations are up to date.", { event: "migration_skipped", tool: "supabase" });
  }
  if (outcome.skipped) {
    await logger.warn(`Supabase migrations not applied: ${outcome.skipped.reason}`, {
      event: "supabase_migrations_skipped",
      versions: outcome.skipped.versions,
      reason: "unsafe",
    });
  }
  if (outcome.tablesWithoutRls?.length) {
    await logger.warn(
      `Row-level security is off for public table(s) ${outcome.tablesWithoutRls.slice(0, 10).join(", ")}. Anyone with your app's anon key can read and change them.`,
      { event: "supabase_rls_disabled", tables: outcome.tablesWithoutRls.slice(0, 50) },
    );
  }
  if (outcome.failed) {
    await logger.error(`Supabase migration ${outcome.failed.version} failed and was rolled back.`, {
      event: "migration_failed",
      tool: "supabase",
      version: outcome.failed.version,
      detail: outcome.failed.message,
    });
    throw new Error(`Supabase migration ${outcome.failed.version} failed. Deploy was not started.`);
  }
  return outcome;
}

/**
 * Deploy backend services from the validated plan (Render web services: Node, Python, Dockerfile).
 * Resolves env (including sealed DATABASE_URL) in trusted worker code, then
 * calls the real adapter. Never logs secret env values.
 */
export async function deployBackendServices(runId: string): Promise<DeploySummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, deployRef } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const caps = await loadCapabilities(db, run.userId);
  const vault = getVault();

  const summary: DeploySummary = { deployed: [], failed: [], skipped: [] };
  const backendTargets = plan.services.filter(
    (s) => (isWebBackendType(s.type) || s.type === "worker") && s.provider === "render",
  );
  if (backendTargets.length === 0) {
    await logger.log("No Render backend services in plan.", { event: "deploy_skipped" });
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
  const runInputValues = await loadRunInputValues(db, runId, vault);
  const projectEnvValues = await loadProjectEnvValues(db, run.projectId, vault, plan);
  const { values: integrationValues } = await loadIntegrationValues(db, run.userId, plan, vault, runInputValues);

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
    if (!types?.has(svc.type)) {
      summary.skipped.push({ id: svc.id, reason: "capability_missing" });
      continue;
    }

    const [existing] = await db
      .select()
      .from(deployedResources)
      .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, svc.id)))
      .limit(1);
    const isWorker = svc.type === "worker";
    if (existing?.status === "live" && (existing.url || isWorker)) {
      summary.skipped.push({ id: svc.id, reason: "already_deployed" });
      continue;
    }

    const { env, issues, deferred } = await resolveServiceEnv(svc, plan, deployedRows, vault, {
      deferFrontendOrigins: true,
      runInputValues,
      projectEnvValues,
      integrationValues,
    });
    if (issues.length > 0) {
      summary.skipped.push({ id: svc.id, reason: issues[0]?.code ?? "env_unresolved" });
      await logger.warn(`Cannot deploy "${svc.id}": env resolution blocked.`, {
        event: "deploy_env_blocked",
        serviceId: svc.id,
        issues: issues.map((i) => i.code),
        diagnosis: diagnosisForEnvUnresolved({
          serviceId: svc.id,
          issues: issues.map((i) => i.code),
        }),
      });
      continue;
    }
    if (deferred.length > 0) {
      await logger.log(
        `Deferring ${deferred.join(", ")} for "${svc.id}" until the frontend is live.`,
        { event: "env_deferred", serviceId: svc.id, deferred },
      );
    }

    await logger.log(`Deploying backend "${svc.id}" to Render`, {
      event: "deploy_started",
      serviceId: svc.id,
      provider: "render",
    });

    const deployTarget = await resolveProviderDeployTarget(db, run.projectId, svc.id, "render", 60);

    const deployLogs = chainedDeployOnLog(logger, svc.id);
    const result = await adapter.deploy({
      service: svc,
      repo: { fullName: repoFullName, ...deployRef },
      rootDir: svc.rootDir,
      resourceName: deployTarget.resourceName,
      existingExternalId: deployTarget.existingExternalId,
      env,
      credentials: { provider: "render", values: credValues },
      onLog: deployLogs.onLog,
    });
    await deployLogs.flush();

    if (!result.ok || (!result.publicUrl && !isWorker)) {
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
        meta: resourceMeta({
          provider: "render",
          externalId: result.externalId,
          resourceName: deployTarget.resourceName,
          extra: failureMeta(kind, result.logs, result.diagnosis),
        }),
      });
      await logger.error(`Deploy failed for "${svc.id}".`, {
        event: kind === "setup_blocker" ? "deploy_setup_blocker" : "deploy_failed",
        serviceId: svc.id,
        failureKind: kind,
        detail: result.logs,
      });
      await emitDeployFailureGuidance(logger, {
        repoFullName,
        service: svc,
        provider: "render",
        failureKind: kind,
        errorSummary: result.logs,
        ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
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
      meta: resourceMeta({
        provider: "render",
        externalId: result.externalId,
        resourceName: deployTarget.resourceName,
        extra: {
          ...(deferred.length > 0 ? { deferredEnv: deferred } : {}),
          ...(isWorker && result.externalId
            ? { consoleUrl: `https://dashboard.render.com/worker/${encodeURIComponent(result.externalId)}` }
            : {}),
        },
      }),
    });

    summary.deployed.push(svc.id);
    await logger.log(`${isWorker ? "Worker" : "Backend"} "${svc.id}" deployed`, {
      event: "service_deployed",
      serviceId: svc.id,
      provider: "render",
      serviceRole: isWorker ? "worker" : "backend",
      externalId: result.externalId,
      publicUrl: result.publicUrl,
    });
  }

  return summary;
}

/**
 * Deploy frontend services (static and Next.js SSR) to Vercel. Runs after
 * backend deploy so generated_from_service refs resolve from
 * deployed_resources.url.
 */
export async function deployFrontendServices(runId: string): Promise<DeploySummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, deployRef } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const caps = await loadCapabilities(db, run.userId);
  const vault = getVault();

  const summary: DeploySummary = { deployed: [], failed: [], skipped: [] };
  const frontendTargets = plan.services.filter(
    (s) => (s.type === "frontend_static" || s.type === "frontend_ssr") && s.provider === "vercel",
  );
  if (frontendTargets.length === 0) {
    await logger.log("No Vercel frontend services in plan.", { event: "deploy_skipped" });
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
    if (!types?.has(svc.type)) {
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
    const runInputValues = await loadRunInputValues(db, runId, vault);
    const projectEnvValues = await loadProjectEnvValues(db, run.projectId, vault, plan);
    const { values: integrationValues } = await loadIntegrationValues(db, run.userId, plan, vault, runInputValues);
    const { env, issues } = await resolveServiceEnv(svc, plan, deployedRows, vault, {
      runInputValues,
      projectEnvValues,
      integrationValues,
    });
    if (issues.length > 0) {
      summary.skipped.push({ id: svc.id, reason: issues[0]?.code ?? "env_unresolved" });
      await logger.warn(`Cannot deploy "${svc.id}": env resolution blocked.`, {
        event: "deploy_env_blocked",
        serviceId: svc.id,
        issues: issues.map((i) => i.code),
        diagnosis: diagnosisForEnvUnresolved({
          serviceId: svc.id,
          issues: issues.map((i) => i.code),
        }),
      });
      continue;
    }

    await logger.log(`Deploying frontend "${svc.id}" to Vercel`, {
      event: "deploy_started",
      serviceId: svc.id,
      provider: "vercel",
    });

    const deployTarget = await resolveProviderDeployTarget(db, run.projectId, svc.id, "vercel", 52);

    const deployLogs = chainedDeployOnLog(logger, svc.id);
    const result = await adapter.deploy({
      service: svc,
      repo: { fullName: repoFullName, ...deployRef },
      rootDir: svc.rootDir,
      resourceName: deployTarget.resourceName,
      existingExternalId: deployTarget.existingExternalId,
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
        meta: resourceMeta({
          provider: "vercel",
          externalId: result.externalId,
          resourceName: deployTarget.resourceName,
          teamId: credValues.teamId,
          extra: failureMeta(kind, result.logs, result.diagnosis),
        }),
      });
      const setupMsg =
        kind === "provider_limit"
          ? `Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects. Delete old Vercel projects or reuse an existing project.`
          : kind === "provider_env_conflict"
            ? `Vercel could not update an environment variable after retrying. This is a provider-side env conflict â€” rerun Deploy after ShipFix replaces the variable, or check the Vercel project settings.`
          : kind === "setup_blocker"
            ? result.logs?.trim() ||
              `Deploy blocked for "${svc.id}": update the Vercel connection (token/teamId/GitHub link), then retry.`
            : kind === "timeout"
              ? `Frontend "${svc.id}" deployment timed out on Vercel. Backend and database may still be live â€” check Vercel deployment logs or rerun Deploy.`
              : `Deploy failed for "${svc.id}".`;
      await logger.error(setupMsg, {
        event:
          kind === "provider_limit"
            ? "deploy_provider_limit"
            : kind === "provider_env_conflict"
              ? "deploy_provider_env_conflict"
            : kind === "setup_blocker"
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
      await emitDeployFailureGuidance(logger, {
        repoFullName,
        service: svc,
        provider: "vercel",
        failureKind: kind,
        errorSummary: result.logs,
        ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
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
      meta: resourceMeta({
        provider: "vercel",
        externalId: result.externalId,
        resourceName: deployTarget.resourceName,
        teamId: credValues.teamId,
      }),
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

/**
 * Revalidate, then pause the run when it still needs an answer. Saving an
 * answer signals the workflow, which calls this again.
 */
export async function beginInputWait(runId: string): Promise<{ waiting: boolean }> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  try {
    const { revalidatePlanForRun } = await import("./revalidatePlan");
    await revalidatePlanForRun(db, runId);
  } catch {
    /* the stored plan still decides */
  }

  const plan = await loadPlan(db, runId);
  const { run } = await loadRun(db, runId);
  const inputRows = await db
    .select({ questionId: runInputs.questionId })
    .from(runInputs)
    .where(eq(runInputs.runId, runId));
  const envRows = await db
    .select({ name: projectEnvVars.name })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, run.projectId));
  const answered = new Set(inputRows.map((r) => r.questionId));
  const envNames = new Set(envRows.map((r) => r.name));
  const waiting = shouldWaitForInput(plan, answered, envNames);

  if (!waiting) {
    if (run.status === "awaiting_input") await setStatus(db, runId, "provisioning");
    return { waiting: false };
  }

  if (run.status !== "awaiting_input") {
    await setStatus(db, runId, "awaiting_input");
    await logger.stage("awaiting_input", "Waiting for your answer. This deploy continues when you save it.");
    for (const q of plan.questions) {
      if (questionSatisfied(q.id, answered, envNames)) continue;
      await logger.warn(q.prompt, {
        event: "question",
        questionId: q.id,
        kind: q.kind,
        ...(q.help ? { help: q.help } : {}),
        ...(q.helpUrl ? { helpUrl: q.helpUrl } : {}),
        ...(q.options ? { options: q.options } : {}),
      });
    }
  }
  return { waiting: true };
}

/** The deploy stayed paused until the wait expired. A new deploy can still use saved answers. */
export async function noteInputWaitExpired(runId: string): Promise<void> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const message = "ShipFix waited 7 days for an answer, then stopped this deploy. Answer the questions and deploy again.";
  await logger.warn(message, { event: "input_wait_expired" });
  await setStatus(db, runId, "diagnosed", true);
  await logger.stage("diagnosed", message);
}

export interface RepairSummary {
  /** Services with a verified fix applied (new plan version or pushed branch): redeploy these. */
  retry: string[];
  fixed: string[];
  needsUser: string[];
  gaveUp: string[];
  /** A verified code fix exists but ShipFix could not push it (no GitHub write access). */
  unpushed: string[];
  /** Services paused for a missing setting. The workflow asks, then redeploys. */
  asked: string[];
}

interface FailedServiceMeta {
  failureKind?: DeployFailureKind;
  diagnosis?: LogDiagnosis;
  failureLog?: string;
  repairAttempted?: boolean;
}

const REPAIRABLE_FAILURES: ReadonlySet<string> = new Set(["build_failed", "deploy_failed"]);
const REPAIR_DEADLINE_MS = 25 * 60_000;

/** Every code fix recorded on this run so far (all repair rounds), oldest first. */
async function runRepairFixes(db: Database, runId: string): Promise<PullRequestFix[]> {
  const rows = await db
    .select({ meta: deployedResources.meta })
    .from(deployedResources)
    .where(eq(deployedResources.runId, runId))
    .orderBy(deployedResources.createdAt);
  return rows.flatMap((r) => {
    const fix = (r.meta as { repairFix?: PullRequestFix } | null)?.repairFix;
    return fix ? [fix] : [];
  });
}

async function openRepairPullRequest(
  db: Database,
  logger: RunLogger,
  args: { runId: string; token: string | null; repoFullName: string; baseBranch: string; branch: string; branchUrl: string },
): Promise<void> {
  const compareUrl = `https://github.com/${args.repoFullName}/compare/${encodeURIComponent(args.baseBranch)}...${encodeURIComponent(args.branch)}?expand=1`;
  const fixes = await runRepairFixes(db, args.runId);
  const pr = args.token && fixes.length
    ? await openOrUpdatePullRequest({
        token: args.token,
        repoFullName: args.repoFullName,
        head: args.branch,
        base: args.baseBranch,
        title: pullRequestTitle(fixes),
        body: pullRequestBody({ fixes, baseBranch: args.baseBranch, repairBranch: args.branch }),
      })
    : null;
  if (pr?.ok) {
    await logger.log(`${pr.created ? "Opened" : "Updated"} pull request #${pr.number} with the fix. Merge it to keep the fix.`, {
      event: "repair_pr_opened",
      number: pr.number,
      url: pr.url,
      created: pr.created,
      branch: args.branch,
      baseBranch: args.baseBranch,
      title: pullRequestTitle(fixes),
    });
    return;
  }
  await logger.warn(
    `The fix is on branch "${args.branch}", but ShipFix couldn't open the pull request${pr && !pr.ok ? ` (${pr.error})` : " (the GitHub App has no pull request access)"}. Open it yourself to keep the fix.`,
    { event: "repair_pr_unavailable", branch: args.branch, branchUrl: args.branchUrl, url: compareUrl },
  );
}

/** Branch ShipFix pushes verified fixes to; one per run so reruns don't collide. */
export function repairBranchName(runId: string): string {
  return `shipfix/fix-${runId.slice(0, 8)}`;
}

/**
 * The autofix loop. For each service whose latest deploy failed with a
 * diagnosed build/start error: try the rule-based fix, else the model, and
 * rebuild every candidate in a fresh sandbox before accepting it. Verified
 * command/env fixes become a new plan version; verified code fixes are pushed
 * to a ShipFix branch that providers then deploy. Never touches the default branch.
 */
export async function repairFailedDeploys(runId: string): Promise<RepairSummary> {
  const summary: RepairSummary = { retry: [], fixed: [], needsUser: [], gaveUp: [], unpushed: [], asked: [] };
  if (process.env.SHIPFIX_AUTOFIX?.trim().toLowerCase() === "off") return summary;

  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, githubInstallationId, deployRef, defaultBranch } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);

  const rows = await db
    .select()
    .from(deployedResources)
    .where(and(eq(deployedResources.runId, runId), eq(deployedResources.kind, "service")))
    .orderBy(deployedResources.createdAt);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.serviceId, r);
  const targets = [...latest.values()].flatMap((row) => {
    const meta = (row.meta ?? {}) as FailedServiceMeta;
    const svc = plan.services.find((s) => s.id === row.serviceId);
    if (row.status !== "failed" || !svc || !meta.diagnosis || meta.repairAttempted) return [];
    if (!meta.failureKind || !REPAIRABLE_FAILURES.has(meta.failureKind)) return [];
    return [{ row, meta, svc, diagnosis: meta.diagnosis }];
  });
  if (targets.length === 0) return summary;

  const sandbox = await createRunSandboxProvider().create({ runId });
  const fileEdits = new Map<string, FileEdit>();
  const planEdits: PlanEdit[] = [];
  const codeFixed: string[] = [];
  const planOnlyFixed: string[] = [];
  const codeFixes: PullRequestFix[] = [];
  const missingSettings: MissingSetting[] = [];
  try {
    const cloneToken = await resolveCloneToken({
      repoFullName,
      installationId: githubInstallationId,
      allowedInstallationIds: await ownedGithubInstallationIds(db, run.userId),
    });
    await sandbox.clone({ repoFullName, sha: deployRef.commitSha, token: cloneToken });
    const posix = (await sandbox.exec("uname", { timeoutMs: 15_000 }).catch(() => null))?.exitCode === 0;
    const llm = lazyGateway(() =>
      meteredGateway(createLLMGateway(), db, {
        userId: run.userId,
        projectId: run.projectId,
        runId,
        operation: REPAIR_OPERATION,
      }),
    );
    const deadline = Date.now() + REPAIR_DEADLINE_MS;

    for (const t of targets) {
      await logger.log(`Trying to fix "${t.svc.id}": ${t.diagnosis.title}`, {
        event: "repair_started",
        serviceId: t.svc.id,
        kind: t.diagnosis.kind,
      });
      const literalEnv = Object.fromEntries(
        t.svc.env.flatMap((e) => (e.source === "literal" && e.value != null ? [[e.name, e.value] as const] : [])),
      );
      const outcome = await runRepairLoop({
        workspace: sandboxRepairWorkspace(sandbox, { smokeStart: t.diagnosis.phase === "start", posix }),
        service: t.svc,
        diagnosis: t.diagnosis,
        log: t.meta.failureLog ?? t.diagnosis.evidence.join("\n"),
        env: literalEnv,
        llm,
        maxAttempts: 3,
        deadline,
        onAttempt: (a, i) =>
          logger.log(`Fix attempt ${i + 1} for "${t.svc.id}": ${a.title} (${a.outcome})`, {
            event: "repair_attempt",
            serviceId: t.svc.id,
            source: a.source,
            outcome: a.outcome,
            files: a.files,
            detail: a.detail,
          }),
      });

      const prFix: PullRequestFix | null =
        outcome.status === "fixed" && outcome.files.length > 0
          ? {
              serviceId: t.svc.id,
              title: outcome.title,
              explanation: outcome.explanation,
              fullyVerified: outcome.fullyVerified,
              files: outcome.files.map((f) => ({ path: f.path, created: f.before === null })),
            }
          : null;
      await db
        .update(deployedResources)
        .set({
          meta: {
            ...(t.row.meta as object),
            repairAttempted: true,
            repairStatus: outcome.status,
            ...(prFix ? { repairFix: prFix } : {}),
          },
        })
        .where(eq(deployedResources.id, t.row.id));

      if (outcome.status === "fixed") {
        summary.fixed.push(t.svc.id);
        for (const f of outcome.files) {
          const prev = fileEdits.get(f.path);
          fileEdits.set(f.path, { path: f.path, before: prev ? prev.before : f.before, after: f.after });
        }
        planEdits.push(...outcome.plan);
        (outcome.files.length ? codeFixed : planOnlyFixed).push(t.svc.id);
        if (prFix) codeFixes.push(prFix);
        await logger.log(`Found a fix for "${t.svc.id}" and it builds in the sandbox: ${outcome.title}`, {
          event: "repair_verified",
          serviceId: t.svc.id,
          title: outcome.title,
          explanation: outcome.explanation,
          fullyVerified: outcome.fullyVerified,
          files: outcome.files.map((f) => f.path),
          planChanges: outcome.plan,
          diff: unifiedDiffs(outcome.files),
        });
      } else if (outcome.status === "needs_user") {
        summary.needsUser.push(t.svc.id);
        if (t.diagnosis.kind === "missing_env" && isSettingName(t.diagnosis.subject)) {
          missingSettings.push({ serviceId: t.svc.id, envName: t.diagnosis.subject });
          summary.asked.push(t.svc.id);
        }
        await logger.warn(`"${t.svc.id}" needs something from you before it can deploy: ${outcome.message}`, {
          event: "repair_needs_user",
          serviceId: t.svc.id,
          message: outcome.message,
        });
      } else {
        summary.gaveUp.push(t.svc.id);
        await logger.warn(outcome.reason, { event: "repair_gave_up", serviceId: t.svc.id, attempts: outcome.attempts.length });
      }
    }
  } catch (err) {
    await logger.warn("Automatic repair stopped early.", {
      event: "repair_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await sandbox.dispose();
  }

  let nextPlan = missingSettings.length > 0 ? withMissingSettings(plan, missingSettings) : plan;
  if (planEdits.length > 0) {
    nextPlan = applyPlanEdits(nextPlan, planEdits);
    summary.retry.push(...planOnlyFixed);
  }
  if (nextPlan !== plan) {
    const [latestPlan] = await db
      .select({ version: plans.version, planner: plans.planner })
      .from(plans)
      .where(eq(plans.runId, runId))
      .orderBy(desc(plans.version))
      .limit(1);
    await db.insert(plans).values({
      runId,
      version: (latestPlan?.version ?? 1) + 1,
      doc: nextPlan,
      planner: latestPlan?.planner ?? "autofix",
      confidence: nextPlan.confidence,
    });
  }

  const files = [...fileEdits.values()].filter((f) => f.before !== f.after);
  if (files.length > 0) {
    const githubScope = {
      repoFullName,
      installationId: githubInstallationId,
      allowedInstallationIds: await ownedGithubInstallationIds(db, run.userId),
    };
    // Pull-request access is optional: an App with only contents:write still gets the branch.
    const prToken = await resolveRepoWriteToken({ ...githubScope, permissions: { contents: "write", pull_requests: "write" } });
    const writeToken = prToken ?? (await resolveRepoWriteToken(githubScope));
    const branch = repairBranchName(runId);
    const pushed = writeToken
      ? await pushCommitToBranch({
          token: writeToken,
          repoFullName,
          baseSha: deployRef.commitSha,
          branch,
          message: commitMessage(codeFixes),
          changes: files.map((f) => ({ path: f.path, content: f.after })),
        })
      : null;
    if (pushed?.ok) {
      await db.update(runs).set({ deployBranch: branch, deploySha: pushed.sha }).where(eq(runs.id, runId));
      summary.retry.push(...codeFixed);
      await logger.log(`Pushed the tested fix to branch "${branch}". Redeploying from it.`, {
        event: "repair_pushed",
        branch,
        commitSha: pushed.sha,
        url: pushed.url,
        files: files.map((f) => f.path),
      });
      await openRepairPullRequest(db, logger, {
        runId,
        token: prToken,
        repoFullName,
        baseBranch: defaultBranch,
        branch,
        branchUrl: pushed.url,
      });
    } else {
      summary.unpushed.push(...codeFixed);
      const diff = unifiedDiffs(files);
      await logger.warn(
        writeToken
          ? `ShipFix tested a fix but GitHub refused the push (${pushed && !pushed.ok ? pushed.error : "unknown error"}). Apply the change below yourself, then redeploy.`
          : "ShipFix found and tested a fix, but it doesn't have permission to push to this repo. Apply the change below yourself (or give the ShipFix GitHub App write access), then redeploy.",
        {
          event: "repair_push_unavailable",
          serviceIds: codeFixed,
          files: files.map((f) => f.path),
          diff,
          fixPrompt: `Apply this tested fix to ${repoFullName}, then commit and push:\n\n${codeFixes
            .map((f) => `${f.title} (${f.serviceId}): ${f.explanation}`)
            .join("\n\n")}\n\n\`\`\`diff\n${diff}\`\`\``,
        },
      );
    }
  }

  return summary;
}

export interface WireDeferredSummary {
  wired: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: string[];
}

/**
 * After the frontend is live, apply deferred backend env (CORS_ORIGIN / web.origin)
 * via Render setEnv + redeploy so verification can prove frontendâ†’backend reachability.
 */
export async function wireDeferredBackendEnv(runId: string): Promise<WireDeferredSummary> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const { run, repoFullName, deployRef } = await loadRun(db, runId);
  const plan = await loadPlan(db, runId);
  const vault = getVault();
  const summary: WireDeferredSummary = { wired: [], skipped: [], failed: [] };

  const deferredEdges = plan.wiring.filter(
    (w) =>
      w.fromServiceId === "web" &&
      (w.fromField === "origin" || w.fromField === "publicUrl") &&
      plan.services.some((s) => s.id === w.toServiceId && isWebBackendType(s.type)),
  );
  if (deferredEdges.length === 0) {
    await logger.log("No deferred backend origin wiring.", { event: "env_wire_skipped" });
    return summary;
  }

  const backendIds = [...new Set(deferredEdges.map((e) => e.toServiceId))];
  const deployedRows = await loadDeployedRows(db, runId);
  const web = deployedRows.find((r) => r.serviceId === "web" && r.status === "live" && r.url);
  if (!web?.url) {
    for (const id of backendIds) {
      summary.skipped.push({ id, reason: "frontend_not_live" });
    }
    await logger.warn("Frontend is not live â€” cannot wire CORS origins yet.", {
      event: "env_wire_skipped",
      reason: "frontend_not_live",
    });
    return summary;
  }

  if (!adapters.has("render")) {
    for (const id of backendIds) summary.skipped.push({ id, reason: "render_unavailable" });
    return summary;
  }

  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, run.userId));
  const renderAccount = accounts.find((a) => a.provider === "render");
  if (!renderAccount) {
    for (const id of backendIds) summary.skipped.push({ id, reason: "render_not_connected" });
    return summary;
  }

  const adapter = adapters.get("render");
  const credValues = await decryptProviderCredentials(vault, renderAccount);
  await setStatus(db, runId, "wiring");
  await logger.stage("wiring", "Wiring frontend origin into backend CORS env");

  for (const backendId of backendIds) {
    const svc = plan.services.find((s) => s.id === backendId);
    if (!svc || svc.provider !== "render") {
      summary.skipped.push({ id: backendId, reason: "not_render" });
      continue;
    }

    const [row] = await db
      .select()
      .from(deployedResources)
      .where(and(eq(deployedResources.runId, runId), eq(deployedResources.serviceId, backendId)))
      .limit(1);
    if (!row?.externalId || row.status !== "live") {
      summary.skipped.push({ id: backendId, reason: "backend_not_live" });
      continue;
    }

    const runInputValues = await loadRunInputValues(db, runId, vault);
    const { env, issues } = await resolveServiceEnv(svc, plan, deployedRows, vault, {
      runInputValues,
      projectEnvValues: await loadProjectEnvValues(db, run.projectId, vault, plan),
      integrationValues: (await loadIntegrationValues(db, run.userId, plan, vault, runInputValues)).values,
    });
    if (issues.length > 0) {
      summary.failed.push(backendId);
      await logger.error(`Cannot wire origins for "${backendId}": env still unresolved.`, {
        event: "env_wire_failed",
        serviceId: backendId,
        issues: issues.map((i) => i.code),
      });
      continue;
    }

    const originVars = deferredEdges
      .filter((e) => e.toServiceId === backendId)
      .map((e) => e.toEnvName);
    const patch: Record<string, string> = {};
    for (const name of originVars) {
      if (env[name]) patch[name] = env[name]!;
    }
    if (Object.keys(patch).length === 0) {
      summary.skipped.push({ id: backendId, reason: "nothing_to_wire" });
      continue;
    }

    try {
      await adapter.setEnv(row.externalId, patch, {
        provider: "render",
        values: credValues,
      });
      // Force a redeploy so the new env is picked up by the running service.
      const deployTarget = await resolveProviderDeployTarget(db, run.projectId, svc.id, "render", 60);
      const deployLogs = chainedDeployOnLog(logger, svc.id);
      const result = await adapter.deploy({
        service: svc,
        repo: { fullName: repoFullName, ...deployRef },
        rootDir: svc.rootDir,
        resourceName: deployTarget.resourceName,
        existingExternalId: row.externalId,
        env,
        credentials: { provider: "render", values: credValues },
        onLog: deployLogs.onLog,
      });
      await deployLogs.flush();
      if (!result.ok) {
        summary.failed.push(backendId);
        await logger.error(`Origin wiring redeploy failed for "${backendId}".`, {
          event: "env_wire_failed",
          serviceId: backendId,
          detail: result.logs,
        });
        continue;
      }

      const prevMeta =
        row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
          ? (row.meta as Record<string, unknown>)
          : {};
      await db
        .update(deployedResources)
        .set({
          meta: { ...prevMeta, deferredEnv: [], originsWired: originVars },
          url: result.publicUrl ?? row.url,
        })
        .where(eq(deployedResources.id, row.id));

      summary.wired.push(backendId);
      await logger.log(`Wired frontend origin into "${backendId}" (${originVars.join(", ")})`, {
        event: "env_wired",
        serviceId: backendId,
        envNames: originVars,
        origin: new URL(web.url!).origin,
      });
    } catch (e) {
      summary.failed.push(backendId);
      await logger.error(`Origin wiring failed for "${backendId}".`, {
        event: "env_wire_failed",
        serviceId: backendId,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Wiring failures are recorded above and surface through verification (the CORS
  // check fails) and finalizeDeployRun, which keeps live services visible.
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
  const vault = getVault();

  const summary: PlanVerifySummary = { passed: [], failed: [], skipped: [] };

  const rows = await db
    .select()
    .from(deployedResources)
    .where(and(eq(deployedResources.runId, runId), eq(deployedResources.kind, "service")));
  const live = rows.filter((r) => r.status === "live" && r.url);

  if (live.length === 0 && !plan.verification.some((c) => c.check === "db_connect")) {
    await logger.log("No deployed services to verify.", { event: "verify_skipped" });
    return summary;
  }

  if (plan.verification.length === 0) {
    await logger.log("Plan defines no verification checks.", { event: "verify_skipped" });
    return summary;
  }

  await setStatus(db, runId, "verifying");
  await logger.stage("verifying", `Running ${plan.verification.length} verification check(s)`);

  const dbConnections: Record<string, string> = {};
  if (plan.verification.some((c) => c.check === "db_connect")) {
    const managedRows = await loadDeployedRows(db, runId);
    for (const check of plan.verification.filter((c) => c.check === "db_connect")) {
      const row = managedRows.find((r) => r.serviceId === check.serviceId && r.status === "live");
      if (!row) continue;
      if (!row.encBlob || !row.encIv || !row.encDek) continue;
      // The sealed secret itself; each provisioner's verify knows how to read it.
      dbConnections[check.serviceId] = await vault.open({ encBlob: row.encBlob, encIv: row.encIv, encDek: row.encDek });
    }
  }

  const neon = createNeonProvisioner();
  const upstash = createUpstashProvisioner();
  const resourceRefs = live.map((r) => ({ serviceId: r.serviceId, publicUrl: r.url! }));
  const outcomes = await verifyFromPlan(plan, resourceRefs, {
    dbConnections,
    verifyDbConnect: async (secret) =>
      isRedisSecret(secret)
        ? upstash.verify({ name: "REDIS_URL", value: secret })
        : neon.verify({ name: "DATABASE_URL", value: secret }),
  });

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
    // On fallback substitution the passing probe is the last result, not the
    // first â€” report the URL/status that actually proved (or disproved) health.
    const decisive = o.results.find((r) => r.ok) ?? primary;
    const diagnosis = diagnosisFromVerifyOutcome(o, plan, resourceRefs);
    await logger.log(
      `"${o.serviceId}" ${o.check}: ${o.ok ? "passed" : "failed"} (${decisive?.detail ?? "unknown"})`,
      {
        event: "verification",
        check: o.check,
        serviceId: o.serviceId,
        ok: o.ok,
        statusCode: decisive?.statusCode ?? null,
        url: decisive?.url ?? null,
        assumedPath: o.assumedPath ?? false,
        substitutedPath: o.substitutedPath ?? null,
        probedPaths: o.results.length > 1 ? o.results.map((r) => r.url) : undefined,
        ...(diagnosis ? { diagnosis } : {}),
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

// â”€â”€ Deploy-mode activities (intentionally unimplemented beyond this slice) â”€â”€â”€

/**
 * Bounded recovery after deploy: re-verify, and for CORS failures re-wire
 * deferred backend origins up to 2 times. Does not mutate the user's repo.
 */
export async function verifySystem(runId: string): Promise<{
  ok: boolean;
  verify: PlanVerifySummary;
  attempts: number;
  actions: string[];
}> {
  const db = getDb();
  const logger = createRunLogger(runId, createSafePostgresSink(db));
  const actions: string[] = [];
  let attempts = 0;

  let verify = await verifyDeployedPlan(runId);
  if (verify.failed.length === 0) {
    return { ok: true, verify, attempts: 0, actions };
  }

  const maxAttempts = 2;
  while (attempts < maxAttempts && verify.failed.length > 0) {
    const corsFailed = verify.failed.some((f) => f.check === "cors_from");
    const dbFailed = verify.failed.some((f) => f.check === "db_connect");
    const healthFailed = verify.failed.some(
      (f) => f.check === "health_path" || f.check === "http_2xx" || f.check === "frontend_loads",
    );

    if (dbFailed && !corsFailed) {
      // DB connectivity is not recoverable by rewiring origins.
      await logger.warn("Verification failed on database reachability; skipping automatic recovery.", {
        event: "recovery_skipped",
        reason: "db_unreachable",
        failed: verify.failed,
      });
      break;
    }

    if (!corsFailed && healthFailed) {
      await logger.warn("Verification failed on health checks; automatic recovery is limited to CORS rewiring.", {
        event: "recovery_skipped",
        reason: "health_failed",
        failed: verify.failed,
      });
      break;
    }

    if (!corsFailed) break;

    attempts += 1;
    actions.push("wireDeferredBackendEnv");
    await logger.log(`Recovery attempt ${attempts}/${maxAttempts}: re-wiring backend CORS origins`, {
      event: "recovery_attempt",
      attempt: attempts,
      action: "wireDeferredBackendEnv",
      failed: verify.failed,
    });
    await wireDeferredBackendEnv(runId);
    actions.push("verifyDeployedPlan");
    verify = await verifyDeployedPlan(runId);
    if (verify.failed.length === 0) {
      await logger.log("Recovery succeeded â€” verification passed after rewiring origins.", {
        event: "recovery_succeeded",
        attempts,
      });
      return { ok: true, verify, attempts, actions };
    }
  }

  if (verify.failed.length > 0) {
    await logger.warn("Bounded recovery exhausted; leaving run for diagnosis.", {
      event: "recovery_exhausted",
      attempts,
      failed: verify.failed,
      actions,
    });
  }

  return { ok: verify.failed.length === 0, verify, attempts, actions };
}

/** Legacy finalize stub â€” deploy mode uses finalizeDeployRun. */
export async function finalize(_runId: string, _ok: boolean): Promise<void> {
  return notImplemented("finalize");
}
