import type { DeploymentPlan } from "@shipfix/contracts";
import { fetchSupabaseProjectValues, type SupabaseApiOptions } from "@shipfix/provisioner";
import { integrationProjectQuestionId } from "@shipfix/validator";

export interface IntegrationValuesResult {
  /** Keyed by plan ref, e.g. `supabase.anonKey`. Secret — never log. */
  values: Map<string, string>;
  /** User-safe problems (no values), one per integration that couldn't be read. */
  problems: string[];
}

/** Integrations the plan's env actually reads from. */
export function usedIntegrationIds(plan: DeploymentPlan): Set<string> {
  const ids = new Set<string>();
  for (const s of plan.services) {
    for (const e of s.env) if (e.source === "integration" && e.ref) ids.add(e.ref.split(".")[0]);
  }
  return ids;
}

/**
 * Read env values from each integration the plan uses, with the user's
 * decrypted provider credentials. A missing connection or lookup failure is
 * reported as a problem; resolveServiceEnv then flags the affected env vars
 * unless the user set them on the project.
 */
export async function resolveIntegrationValues(
  plan: DeploymentPlan,
  credentialsByProvider: ReadonlyMap<string, Record<string, string>>,
  runInputValues: ReadonlyMap<string, string>,
  opts: SupabaseApiOptions = {},
): Promise<IntegrationValuesResult> {
  const values = new Map<string, string>();
  const problems: string[] = [];
  const used = usedIntegrationIds(plan);
  for (const integration of plan.integrations ?? []) {
    if (!used.has(integration.id) || integration.provider !== "supabase") continue;
    const token = credentialsByProvider.get("supabase")?.accessToken?.trim();
    if (!token) {
      problems.push("Supabase is not connected, so ShipFix can't read your project's URL and keys.");
      continue;
    }
    const projectRef =
      integration.projectRef ?? runInputValues.get(integrationProjectQuestionId(integration.id))?.trim() ?? null;
    const result = await fetchSupabaseProjectValues(token, projectRef, opts);
    if (!result.ok) {
      problems.push(result.message);
      continue;
    }
    const { url, anonKey, serviceRoleKey, projectRef: ref } = result.values;
    values.set(`${integration.id}.url`, url);
    values.set(`${integration.id}.projectRef`, ref);
    if (anonKey) values.set(`${integration.id}.anonKey`, anonKey);
    if (serviceRoleKey) values.set(`${integration.id}.serviceRoleKey`, serviceRoleKey);
  }
  return { values, problems };
}
