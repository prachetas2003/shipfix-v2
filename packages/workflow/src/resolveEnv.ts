import type { DeploymentPlan, EnvVar, PlanService } from "@shipfix/contracts";
import {
  parseNeonConnectionSecret,
  runtimeConnectionUrl,
  type NeonConnectionUrls,
} from "@shipfix/provisioner";
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
  /** Env names deferred until a frontend service is live (e.g. CORS_ORIGIN). */
  deferred: string[];
}

export interface ResolveServiceEnvOptions {
  /**
   * When true, `generated_from_service` refs to frontend services that are not
   * live yet are omitted instead of becoming blocking issues. Used on the first
   * backend deploy pass before the frontend URL exists.
   */
  deferFrontendOrigins?: boolean;
  /**
   * Opened run_inputs values keyed by PlanQuestion id
   * (e.g. `secret-api-STRIPE_SECRET_KEY`). Never log these.
   */
  runInputValues?: ReadonlyMap<string, string>;
  /**
   * Durable project env values keyed by env var name (e.g. `STRIPE_SECRET_KEY`).
   * Used after run_inputs for `user_secret`. Never log these.
   */
  projectEnvValues?: ReadonlyMap<string, string>;
}

/** Question id synthesizer uses for user_secret env vars. */
export function secretQuestionId(serviceId: string, envName: string): string {
  return `secret-${serviceId}-${envName}`;
}

function parseRef(ref: string): { id: string; field: string } | null {
  const [id, field] = ref.split(".");
  if (!id || !field) return null;
  return { id, field };
}

function isFrontendService(plan: DeploymentPlan, serviceId: string): boolean {
  const svc = plan.services.find((s) => s.id === serviceId);
  return svc?.type === "frontend_static" || svc?.type === "frontend_ssr";
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

/** Open sealed managed DB secret into pooled/direct connection roles. */
export async function openManagedConnectionUrls(
  row: DeployedResourceRow,
  vault: SecretVault,
): Promise<NeonConnectionUrls | null> {
  if (!row.encBlob || !row.encIv || !row.encDek) return null;
  const secret = await vault.open({
    encBlob: row.encBlob,
    encIv: row.encIv,
    encDek: row.encDek,
  });
  return parseNeonConnectionSecret(secret);
}

async function resolveEnvVar(
  env: EnvVar,
  serviceId: string,
  managedById: Map<string, DeployedResourceRow>,
  servicesById: Map<string, DeployedResourceRow>,
  vault: SecretVault,
  runInputValues: ReadonlyMap<string, string> | undefined,
  projectEnvValues: ReadonlyMap<string, string> | undefined,
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
    const fromQuestion = runInputValues?.get(secretQuestionId(serviceId, env.name));
    if (fromQuestion != null && fromQuestion !== "") {
      return { name: env.name, value: fromQuestion };
    }
    // Fallback: any answered question whose id ends with -ENV_NAME
    if (runInputValues) {
      for (const [qid, value] of runInputValues) {
        if (qid.endsWith(`-${env.name}`) && value) {
          return { name: env.name, value };
        }
      }
    }
    const fromProject = projectEnvValues?.get(env.name);
    if (fromProject != null && fromProject !== "") {
      return { name: env.name, value: fromProject };
    }
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
    const urls = await openManagedConnectionUrls(row, vault);
    if (!urls) {
      return {
        name: env.name,
        issue: { code: "managed_not_live", managedId: parsed.id, envName: env.name },
      };
    }
    // Runtime services always get the pooled URL when available.
    return { name: env.name, value: runtimeConnectionUrl(urls) };
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
  opts: ResolveServiceEnvOptions = {},
): Promise<ResolveEnvResult> {
  const managedById = new Map(
    deployed.filter((r) => r.exposesEnv != null).map((r) => [r.serviceId, r]),
  );
  const servicesById = new Map(
    deployed.filter((r) => r.exposesEnv == null && r.url != null).map((r) => [r.serviceId, r]),
  );
  const env: Record<string, string> = {};
  const issues: ResolveEnvIssue[] = [];
  const deferred: string[] = [];

  for (const v of service.env) {
    const r = await resolveEnvVar(
      v,
      service.id,
      managedById,
      servicesById,
      vault,
      opts.runInputValues,
      opts.projectEnvValues,
    );
    if (
      opts.deferFrontendOrigins &&
      r.issue &&
      v.source === "generated_from_service" &&
      (r.issue.code === "missing_service" || r.issue.code === "service_not_live")
    ) {
      const parsed = parseRef(v.ref ?? "");
      if (parsed && isFrontendService(plan, parsed.id)) {
        deferred.push(v.name);
        continue;
      }
    }
    if (r.issue) issues.push(r.issue);
    else if (r.value != null) env[r.name] = r.value;
  }
  return { env, issues, deferred };
}
