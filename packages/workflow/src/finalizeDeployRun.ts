import type { DeploymentPlan, PlanService } from "@shipfix/contracts";
import type { Capabilities } from "@shipfix/validator";
import type { DeployFailureKind } from "@shipfix/adapter-core";
import { accountPlanVerifySummary } from "@shipfix/verifier";

export interface DeployFailure {
  id: string;
  kind: DeployFailureKind;
}

export interface DeploySummary {
  deployed: string[];
  failed: DeployFailure[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface PlanVerifySummary {
  passed: Array<{ serviceId: string; check: string }>;
  failed: Array<{ serviceId: string; check: string }>;
  skipped: Array<{ serviceId: string; check: string; reason: string }>;
}

export interface ProvisionSummary {
  provisioned: string[];
  failed: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface DeployRunOutcome {
  provision: ProvisionSummary;
  backendDeploy: DeploySummary;
  frontendDeploy: DeploySummary;
  verify: PlanVerifySummary;
}

export type TerminalDeployStatus = "succeeded" | "diagnosed" | "failed";

export interface FinalizeDeployResult {
  status: TerminalDeployStatus;
  message: string;
}

export interface DeployGateResult {
  allow: boolean;
  /** Terminal status to record when the deploy is blocked. */
  status: TerminalDeployStatus;
  message: string;
}

/**
 * Pure deploy-admission gate. ShipFix only auto-deploys plans the validator
 * classified `deployable` (GREEN). `needs_setup` (YELLOW) and `diagnose_only`
 * (RED) plans are NOT executed — they finalize as `diagnosed` with the concrete
 * setup checklist, so we never call providers for a plan we can't honestly ship.
 */
export function evaluateDeployGate(plan: DeploymentPlan): DeployGateResult {
  if (plan.classification === "deployable") {
    return { allow: true, status: "succeeded", message: "Plan is deployable." };
  }

  const setup = plan.blockers
    .filter((b) => b.severity === "needs_input" || b.severity === "fatal")
    .slice(0, 4)
    .map((b) => b.title);
  const checklist = setup.length ? ` Resolve: ${setup.join("; ")}.` : "";

  if (plan.classification === "needs_setup") {
    return {
      allow: false,
      status: "diagnosed",
      message: `Deploy not started — setup is required first.${checklist} Complete setup and rerun Deploy. No providers were called.`,
    };
  }
  return {
    allow: false,
    status: "diagnosed",
    message: `Deploy not started — this app is not auto-deployable yet, so ShipFix produced a diagnosis instead.${checklist} No providers were called.`,
  };
}

function planServiceIds(plan: DeploymentPlan, filter: (s: PlanService) => boolean): string[] {
  return plan.services.filter(filter).map((s) => s.id);
}

function allServicesDeployed(ids: string[], deployed: string[], failed: DeployFailure[]): boolean {
  if (ids.length === 0) return true;
  const failedIds = new Set(failed.map((f) => f.id));
  return ids.every((id) => deployed.includes(id)) && !ids.some((id) => failedIds.has(id));
}

function hasPartialLiveProgress(outcome: DeployRunOutcome): boolean {
  const { provision, backendDeploy, frontendDeploy } = outcome;
  return (
    provision.provisioned.length > 0 ||
    backendDeploy.deployed.length > 0 ||
    frontendDeploy.deployed.length > 0
  );
}

function planHasUnsupportedServices(plan: DeploymentPlan, caps: Capabilities): boolean {
  for (const svc of plan.services) {
    const types = caps.providers.get(svc.provider);
    if (!types?.has(svc.type)) return true;
  }
  return false;
}

/**
 * Pure terminal outcome for deploy mode. Full-stack succeeded only when every
 * supported service is deployed and every plan verification check passes.
 */
export function computeFinalizeDeployOutcome(
  plan: DeploymentPlan,
  outcome: DeployRunOutcome,
  caps: Capabilities,
): FinalizeDeployResult {
  const { provision, backendDeploy, frontendDeploy, verify } = outcome;
  const unsupported = planHasUnsupportedServices(plan, caps);

  const backendIds = planServiceIds(plan, (s) => s.type === "node_api" && s.provider === "render");
  const frontendIds = planServiceIds(
    plan,
    (s) => (s.type === "frontend_static" || s.type === "frontend_ssr") && s.provider === "vercel",
  );
  const managedIds = plan.managed.filter((m) => m.mode === "provision").map((m) => m.id);
  const hasFullStackPlan = backendIds.length > 0 && frontendIds.length > 0;
  const hasBackendOnlyPlan = backendIds.length > 0 && frontendIds.length === 0;

  const allDeployFailures = [...backendDeploy.failed, ...frontendDeploy.failed];
  const setupBlockers = allDeployFailures.filter((f) => f.kind === "setup_blocker");
  const providerLimits = allDeployFailures.filter((f) => f.kind === "provider_limit");
  const hardDeployFailures = allDeployFailures.filter(
    (f) => f.kind !== "setup_blocker" && f.kind !== "provider_limit",
  );

  const backendsOk = allServicesDeployed(backendIds, backendDeploy.deployed, backendDeploy.failed);
  const frontendsOk = allServicesDeployed(
    frontendIds,
    frontendDeploy.deployed,
    frontendDeploy.failed,
  );
  const managedOk =
    managedIds.length === 0 ||
    (provision.failed.length === 0 &&
      managedIds.every((id) => provision.provisioned.includes(id)));
  const verification = accountPlanVerifySummary(plan, verify);
  const allChecksPassed = verification.allRequiredPassed;
  const hasLiveServices =
    backendDeploy.deployed.length > 0 || frontendDeploy.deployed.length > 0;
  const hasPartial = hasPartialLiveProgress(outcome);

  if (provision.failed.length > 0 && !hasPartial) {
    return {
      status: "failed",
      message: `Database provisioning or verification failed (${provision.failed.join(", ")}). No app was marked live.`,
    };
  }

  if (hardDeployFailures.length > 0 && !hasPartial) {
    return { status: "failed", message: "Service deployment failed." };
  }

  if (!unsupported && managedOk && hasFullStackPlan && backendsOk && frontendsOk && allChecksPassed) {
    const optionalNote =
      verification.optionalFailed.length > 0
        ? ` Optional wiring check(s) did not pass (${verification.optionalFailed.join(", ")}).`
        : "";
    return {
      status: "succeeded",
      message: `App deployed and verified — frontend, backend, and required checks passed.${optionalNote}`,
    };
  }

  if (!unsupported && managedOk && hasBackendOnlyPlan && backendsOk && allChecksPassed) {
    return {
      status: "succeeded",
      message: "Backend deployed and verified.",
    };
  }

  if (!hasLiveServices && provision.provisioned.length === 0) {
    return {
      status: "failed",
      message: "Deployment produced no live services or provisioned resources.",
    };
  }

  const parts: string[] = [];
  if (provision.provisioned.length) parts.push(`provisioned ${provision.provisioned.length} DB(s)`);
  if (backendDeploy.deployed.length) parts.push(`backend(s): ${backendDeploy.deployed.join(", ")}`);
  if (frontendDeploy.deployed.length) parts.push(`frontend(s): ${frontendDeploy.deployed.join(", ")}`);
  if (verify.passed.length) {
    parts.push(`checks passed: ${verify.passed.map((p) => `${p.serviceId}.${p.check}`).join(", ")}`);
  }
  const detail = parts.length ? parts.join("; ") : "deploy finished";
  const failedChecks = verify.failed.map((f) => `${f.serviceId}.${f.check}`).join(", ");

  if (providerLimits.length > 0) {
    const blocked = providerLimits.map((f) => f.id).join(", ");
    return {
      status: "diagnosed",
      message: `${detail}. Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects (services: ${blocked}). Delete old Vercel projects or reuse an existing project. Full-stack app is NOT live.`,
    };
  }

  if (setupBlockers.length > 0) {
    const blocked = setupBlockers.map((f) => f.id).join(", ");
    return {
      status: "diagnosed",
      message: `${detail}. Provider setup required for ${blocked} — connect accounts and rerun deploy. Full-stack app is NOT live.`,
    };
  }

  if (provision.failed.length > 0) {
    return {
      status: "diagnosed",
      message: `${detail}. Database provisioning or verification failed (${provision.failed.join(", ")}) — full-stack app is NOT live.`,
    };
  }

  if (verify.failed.length > 0 && backendsOk && frontendsOk) {
    const failedRequired = verification.requiredFailed;
    if (failedRequired.length > 0) {
      return {
        status: "diagnosed",
        message: `${detail}. Services are live but verification failed (${failedRequired.join(", ")}) — full app is NOT proven working.`,
      };
    }
    return {
      status: "diagnosed",
      message: `${detail}. Services are live but optional wiring checks failed (${verification.optionalFailed.join(", ")}) — core app may still work.`,
    };
  }

  if (verify.failed.length > 0) {
    const failedChecks = verification.requiredFailed.length
      ? verification.requiredFailed.join(", ")
      : verify.failed.map((f) => `${f.serviceId}.${f.check}`).join(", ");
    return {
      status: "diagnosed",
      message: `${detail}. Verification failed (${failedChecks}) — see timeline for details.`,
    };
  }

  if (backendsOk && frontendIds.length > 0 && !frontendsOk) {
    return {
      status: "diagnosed",
      message: `${detail}. Backend is live but frontend did not deploy — full-stack app is NOT live.`,
    };
  }

  if (backendsOk && frontendsOk && unsupported) {
    return {
      status: "diagnosed",
      message: `${detail}. Deployed services are live, but the plan includes unsupported services — full-stack app is NOT live.`,
    };
  }

  if (backendsOk && frontendsOk && !allChecksPassed) {
    const missing = verification.requiredChecks
      .filter((c) => !verification.requiredPassed.has(`${c.serviceId ?? ""}.${c.check ?? ""}`))
      .map((c) => `${c.serviceId}.${c.check}`)
      .join(", ");
    return {
      status: "diagnosed",
      message: `${detail}. Services deployed but required verification did not complete${missing ? ` (${missing})` : ""} — see timeline.`,
    };
  }

  if (hardDeployFailures.length > 0 && hasPartial) {
    return {
      status: "diagnosed",
      message: `${detail}. Some deploy steps failed; see timeline for details.`,
    };
  }

  return {
    status: "diagnosed",
    message: `${detail}. Deployment or verification did not complete — see timeline for details.`,
  };
}
