import type { DeploymentPlan, VerificationCheck } from "@shipfix/contracts";

export interface HealthPathResolution {
  path: string | null;
  assumed: boolean;
  source: "verification_target" | "service_healthCheckPath" | "none";
  detail: string;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  return (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "") || "/";
}

/**
 * Resolve which URL path to probe for a backend health check.
 * Never silently defaults to "/" — missing path returns null.
 */
export function resolveHealthPath(
  plan: DeploymentPlan,
  serviceId: string,
  serviceHealthCheckPath: string | null | undefined,
  checkOverride?: VerificationCheck,
): HealthPathResolution {
  const check =
    checkOverride ??
    plan.verification.find(
      (c: VerificationCheck) =>
        c.serviceId === serviceId && (c.check === "health_path" || c.check === "http_2xx"),
    );

  if (check?.target) {
    return {
      path: normalizePath(check.target),
      assumed: false,
      source: "verification_target",
      detail: `verification target ${normalizePath(check.target)}`,
    };
  }

  if (serviceHealthCheckPath) {
    return {
      path: normalizePath(serviceHealthCheckPath),
      assumed: false,
      source: "service_healthCheckPath",
      detail: `service healthCheckPath ${normalizePath(serviceHealthCheckPath)}`,
    };
  }

  return {
    path: null,
    assumed: false,
    source: "none",
    detail: "no health check path in plan",
  };
}

/** Mark resolution as assumed when validator flagged missing route evidence. */
export function markAssumedIfNeeded(
  resolution: HealthPathResolution,
  unverified: boolean,
): HealthPathResolution {
  if (!resolution.path || !unverified) return resolution;
  return {
    ...resolution,
    assumed: true,
    detail: `${resolution.detail} (assumed — not verified in repo routes)`,
  };
}
