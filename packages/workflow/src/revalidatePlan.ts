/**
 * Revalidate a stored plan after HITL answers / project env (C2).
 * No LLM — loads RepoContext from analysis_completed events and re-runs validatePlan.
 */

import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";
import {
  capabilities as buildCapabilities,
  validatePlan,
  type Capabilities,
  type ManagedProvider,
} from "@shipfix/validator";
import type { Database } from "@shipfix/db";
import {
  plans,
  providerAccounts,
  projectEnvVars,
  runEvents,
  runInputs,
  runs,
  projects,
} from "@shipfix/db";
import { and, desc, eq } from "drizzle-orm";
import type { PlanProvider, ServiceType } from "@shipfix/contracts";

export interface RevalidateResult {
  plan: DeploymentPlan;
  classification: DeploymentPlan["classification"];
  changed: boolean;
  /** True when RepoContext was found on the run timeline. */
  hadRepoContext: boolean;
}

async function loadRepoContextFromEvents(db: Database, runId: string): Promise<RepoContext | null> {
  const rows = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq));
  for (const row of rows) {
    const d = row.data as Record<string, unknown> | null;
    if (!d || d.event !== "analysis_completed") continue;
    const ctx = d.repoContext;
    if (ctx && typeof ctx === "object") return ctx as RepoContext;
  }
  return null;
}

async function loadCapabilitiesForUser(db: Database, userId: string): Promise<Capabilities> {
  const accounts = await db
    .select({ provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, userId));
  const connected = new Set(accounts.map((a) => a.provider));

  const managed: ManagedProvider[] = [];
  if (connected.has("neon")) managed.push("neon");
  const providerServiceTypes: Partial<Record<PlanProvider, ServiceType[]>> = {};
  if (connected.has("render")) providerServiceTypes.render = ["node_api"];
  if (connected.has("vercel")) providerServiceTypes.vercel = ["frontend_static", "frontend_ssr"];
  return buildCapabilities(providerServiceTypes, managed);
}

/**
 * Re-run validatePlan with answered secrets / project env treated as satisfied.
 * Persists a new plan version when classification or blockers change.
 */
export async function revalidatePlanForRun(db: Database, runId: string): Promise<RevalidateResult> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`Run ${runId} not found`);

  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (!project) throw new Error(`Project for run ${runId} not found`);

  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(desc(plans.version))
    .limit(1);
  if (!planRow) throw new Error(`No plan for run ${runId}`);

  const existing = planRow.doc as DeploymentPlan;
  const ctx = await loadRepoContextFromEvents(db, runId);
  if (!ctx) {
    return {
      plan: existing,
      classification: existing.classification,
      changed: false,
      hadRepoContext: false,
    };
  }

  const inputRows = await db
    .select({ questionId: runInputs.questionId })
    .from(runInputs)
    .where(eq(runInputs.runId, runId));
  const satisfiedSecretQuestionIds = new Set(inputRows.map((r) => r.questionId));

  const envRows = await db
    .select({ name: projectEnvVars.name })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, run.projectId));
  const satisfiedEnvNames = new Set(envRows.map((r) => r.name));

  const caps = await loadCapabilitiesForUser(db, project.userId);
  const { plan: validated } = validatePlan(existing, ctx, caps, {
    satisfiedSecretQuestionIds,
    satisfiedEnvNames,
  });

  const changed =
    validated.classification !== existing.classification ||
    validated.blockers.length !== existing.blockers.length ||
    validated.confidence !== existing.confidence;

  if (changed) {
    const nextVersion = planRow.version + 1;
    const [inserted] = await db
      .insert(plans)
      .values({
        runId,
        version: nextVersion,
        doc: validated,
        planner: planRow.planner,
        confidence: validated.confidence,
      })
      .returning();
    await db.update(runs).set({ planId: inserted.id }).where(eq(runs.id, runId));

    // Append a timeline note (seq assigned by sink elsewhere — use direct insert via events if needed).
    // Callers that have a logger should emit plan_revalidated; API will emit via createRunLogger.
  }

  return {
    plan: validated,
    classification: validated.classification,
    changed,
    hadRepoContext: true,
  };
}
