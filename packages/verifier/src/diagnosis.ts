import type { DeploymentPlan, StructuredDiagnosis } from "@shipfix/contracts";
import type { PlanVerifyOutcome } from "./verify";

/**
 * Map a failed (non-skipped) plan verification outcome to a structured diagnosis.
 * Returns null for passes and skips.
 */
export function diagnosisFromVerifyOutcome(
  outcome: PlanVerifyOutcome,
  plan: DeploymentPlan,
  resources: Array<{ serviceId: string; publicUrl: string }>,
): StructuredDiagnosis | null {
  if (outcome.ok || outcome.skipped) return null;

  const byId = new Map(resources.map((r) => [r.serviceId, r.publicUrl]));
  const decisive = outcome.results.find((r) => r.ok) ?? outcome.results[0];
  const check = plan.verification.find(
    (c) => c.serviceId === outcome.serviceId && c.check === outcome.check,
  );

  if (outcome.check === "cors_from") {
    const fromId = check?.target ?? "web";
    return {
      code: "cors_failed",
      fromServiceId: fromId,
      toServiceId: outcome.serviceId,
      fromUrl: byId.get(fromId) ?? null,
      toUrl: byId.get(outcome.serviceId) ?? decisive?.url ?? null,
      evidence: {
        statusCode: decisive?.statusCode ?? null,
        allowOriginHeader: decisive?.allowOrigin ?? null,
        detail: decisive?.detail ?? null,
      },
      action: "Set CORS_ORIGIN (or equivalent) to the frontend origin and redeploy the API.",
    };
  }

  if (outcome.check === "db_connect") {
    return {
      code: "db_unreachable",
      serviceId: outcome.serviceId,
      managedId: outcome.serviceId,
      evidence: { detail: decisive?.detail ?? null },
      action: "Confirm the Neon project is live and DATABASE_URL is wired to the backend, then retry deploy.",
    };
  }

  if (
    outcome.check === "health_path" ||
    outcome.check === "http_2xx" ||
    outcome.check === "frontend_loads"
  ) {
    return {
      code: "health_failed",
      serviceId: outcome.serviceId,
      toUrl: decisive?.url ?? byId.get(outcome.serviceId) ?? null,
      evidence: {
        statusCode: decisive?.statusCode ?? null,
        detail: decisive?.detail ?? null,
        probedPaths: outcome.results.length > 1 ? outcome.results.map((r) => r.url) : undefined,
        check: outcome.check,
      },
      action:
        outcome.check === "frontend_loads"
          ? "Open the Vercel deployment logs, fix the frontend build or runtime error, then redeploy."
          : "Confirm the health path responds 2xx on the live backend, then redeploy or fix the API.",
    };
  }

  return null;
}

export function diagnosisForMigrationFailure(args: {
  managedId: string;
  reason: string;
  detail?: string;
}): StructuredDiagnosis {
  const reasonHint =
    args.reason === "schema_missing"
      ? "Add a Prisma schema (or supported migration tool) under the managed service root."
      : args.reason === "managed_not_live" || args.reason === "secret_missing"
        ? "Ensure the database provisioned successfully before migrations run."
        : "Fix the migration error shown in technical details, then redeploy.";
  return {
    code: "migration_failed",
    managedId: args.managedId,
    evidence: { reason: args.reason, detail: args.detail ?? null },
    action: reasonHint,
  };
}

export function diagnosisForEnvUnresolved(args: {
  serviceId: string;
  issues: string[];
}): StructuredDiagnosis {
  const missingSecret = args.issues.includes("missing_secret");
  return {
    code: "env_unresolved",
    serviceId: args.serviceId,
    evidence: { issues: args.issues },
    action: missingSecret
      ? "Answer the required secret questions or set the env var on the app Environment page, then redeploy."
      : "Wait for dependencies to become live, or fix the missing wiring, then redeploy.",
  };
}
