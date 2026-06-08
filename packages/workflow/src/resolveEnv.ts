import type { DeploymentPlan, EnvVar, PlanService } from "@shipfix/contracts";
import type { SecretVault } from "@shipfix/secrets";

/** Row shape needed from deployed_resources for env resolution. */
export interface DeployedResourceRow {
  serviceId: string;
  status: string;
  /** Public URL for deployed services (generated_from_service refs). */
  url: string | null;
  exposesEnv: string | null;
  encBlob: Buffer | null;
  encIv: Buffer | null;
  encDek: Buffer | null;
}

export type ResolveEnvIssue =
  | { code: "missing_managed"; managedId: string; envName: string }
  | { code: "managed_not_live"; managedId: string; envName: string }
  | { code: "missing_service"; serviceId: string; envName: string }
  | { code: "service_not_live"; serviceId: string; envName: string }
  | { code: "unsupported_field"; envName: string; field: string }
  | { code: "missing_secret"; envName: string }
  | { code: "unsupported_source"; envName: string; source: string }
  | { code: "literal_missing"; envName: string };

export interface ResolveEnvResult {
  env: Record<string, string>;
  issues: ResolveEnvIssue[];
}

function parseRef(ref: string): { id: string; field: string } | null {
  const [id, field] = ref.split(".");
  if (!id || !field) return null;
  return { id, field };
}

function serviceFieldValue(row: DeployedResourceRow, field: string): string | null {
  if (!row.url) return null;
  if (field === "publicUrl") return row.url;
  if (field === "origin") {
    try {
      return new URL(row.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveEnvVar(
  env: EnvVar,
  managedById: Map<string, DeployedResourceRow>,
  servicesById: Map<string, DeployedResourceRow>,
  vault: SecretVault,
): Promise<{ name: string; value?: string; issue?: ResolveEnvIssue }> {
  if (env.source === "literal") {
    if (env.value == null || env.value === "") {
      return { name: env.name, issue: { code: "literal_missing", envName: env.name } };
    }
    return { name: env.name, value: env.value };
  }
  if (env.source === "provider_injected") {
    return { name: env.name };
  }
  if (env.source === "user_secret") {
    return { name: env.name, issue: { code: "missing_secret", envName: env.name } };
  }
  if (env.source === "generated_from_service") {
    const parsed = parseRef(env.ref ?? "");
    if (!parsed || (parsed.field !== "publicUrl" && parsed.field !== "origin")) {
      return {
        name: env.name,
        issue: { code: "unsupported_field", envName: env.name, field: parsed?.field ?? env.ref ?? "" },
      };
    }
    const row = servicesById.get(parsed.id);
    if (!row) {
      return {
        name: env.name,
        issue: { code: "missing_service", serviceId: parsed.id, envName: env.name },
      };
    }
    if (row.status !== "live") {
      return {
        name: env.name,
        issue: { code: "service_not_live", serviceId: parsed.id, envName: env.name },
      };
    }
    const value = serviceFieldValue(row, parsed.field);
    if (!value) {
      return {
        name: env.name,
        issue: { code: "service_not_live", serviceId: parsed.id, envName: env.name },
      };
    }
    return { name: env.name, value };
  }
  if (env.source === "generated_from_managed") {
    const parsed = parseRef(env.ref ?? "");
    if (!parsed || parsed.field !== "connectionUrl") {
      return {
        name: env.name,
        issue: { code: "unsupported_source", envName: env.name, source: env.ref ?? "" },
      };
    }
    const row = managedById.get(parsed.id);
    if (!row) {
      return {
        name: env.name,
        issue: { code: "missing_managed", managedId: parsed.id, envName: env.name },
      };
    }
    if (row.status !== "live" || !row.encBlob || !row.encIv || !row.encDek) {
      return {
        name: env.name,
        issue: { code: "managed_not_live", managedId: parsed.id, envName: env.name },
      };
    }
    const secret = await vault.open({ encBlob: row.encBlob, encIv: row.encIv, encDek: row.encDek });
    return { name: env.name, value: secret };
  }
  return {
    name: env.name,
    issue: { code: "unsupported_source", envName: env.name, source: env.source },
  };
}

/**
 * Resolve a service's env map from the validated plan + deployed resources.
 * Plaintext values exist only in the returned map (caller must not log them).
 * Managed secrets come from vault.open; service URLs from deployed_resources.url.
 */
export async function resolveServiceEnv(
  service: PlanService,
  plan: DeploymentPlan,
  deployed: DeployedResourceRow[],
  vault: SecretVault,
): Promise<ResolveEnvResult> {
  void plan;
  const managedById = new Map(
    deployed.filter((r) => r.exposesEnv != null).map((r) => [r.serviceId, r]),
  );
  const servicesById = new Map(
    deployed.filter((r) => r.exposesEnv == null && r.url != null).map((r) => [r.serviceId, r]),
  );
  const env: Record<string, string> = {};
  const issues: ResolveEnvIssue[] = [];

  for (const v of service.env) {
    const r = await resolveEnvVar(v, managedById, servicesById, vault);
    if (r.issue) issues.push(r.issue);
    else if (r.value != null) env[r.name] = r.value;
  }
  return { env, issues };
}
