import type { Blocker } from "@shipfix/contracts";

export type IssueSeverity = "fatal" | "needs_input" | "warning";

/** A single deterministic finding from validation. */
export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  /** Plain-English, user-facing explanation. */
  message: string;
  /** Plan path / id the issue concerns (e.g. "services.web", "wiring[0]"). */
  path?: string;
}

/** Human-facing titles + suggested actions per issue code. */
const META: Record<string, { title: string; action: string }> = {
  no_services: {
    title: "No deployable services",
    action: "The plan claims to be deployable but lists no services. Re-run analysis.",
  },
  service_root_unknown: {
    title: "Service points to a path not in the repo",
    action: "ShipFix could not find this service's root directory in the repository.",
  },
  install_command_ungrounded: {
    title: "Install command not found in package scripts",
    action: "The referenced npm script does not exist in the service's package.json.",
  },
  build_command_ungrounded: {
    title: "Build command not found in package scripts",
    action: "The referenced npm script does not exist in the service's package.json.",
  },
  start_command_ungrounded: {
    title: "Start command not found in package scripts",
    action: "The referenced npm script does not exist in the service's package.json.",
  },
  frontend_build_missing: {
    title: "Frontend build script missing",
    action: "Add a build script that produces static files before using ShipFix auto-deploy.",
  },
  backend_start_missing: {
    title: "Backend start script missing",
    action: "Add a start script for the Node API before using ShipFix auto-deploy.",
  },
  repo_python_unsupported: {
    title: "Python apps are not auto-deployable yet",
    action: "Deploy this app manually for now. ShipFix alpha supports Vite/static frontends, Node APIs, and Neon Postgres.",
  },
  repo_docker_unsupported: {
    title: "Docker apps are not auto-deployable yet",
    action: "Deploy this Docker app manually for now. ShipFix will not create provider resources for it.",
  },
  repo_ssr_unsupported: {
    title: "SSR apps are not auto-deployable yet",
    action: "ShipFix does not support Next.js/SSR deployment in this alpha. Use a supported Vite/static frontend or deploy manually.",
  },
  repo_unknown_framework: {
    title: "Unknown app framework",
    action: "ShipFix could not prove this repo matches the supported alpha path, so it will diagnose instead of deploying.",
  },
  deploy_order_unknown_id: {
    title: "Deploy order references an unknown id",
    action: "deployOrder contains an id that is not a service or managed service.",
  },
  deploy_order_missing_id: {
    title: "A service is missing from deploy order",
    action: "Every service and managed service must appear in deployOrder.",
  },
  deploy_order_duplicate: {
    title: "Duplicate id in deploy order",
    action: "An id appears more than once in deployOrder.",
  },
  wiring_unknown_from: {
    title: "Wiring source service does not exist",
    action: "A wiring edge references a source id that is not in the plan.",
  },
  wiring_unknown_to: {
    title: "Wiring target service does not exist",
    action: "A wiring edge references a target id that is not in the plan.",
  },
  wiring_bad_field: {
    title: "Wiring field/source mismatch",
    action: "connectionUrl must come from a managed service; publicUrl/origin from a service.",
  },
  wiring_empty_env: {
    title: "Wiring has no target env var",
    action: "A wiring edge does not specify which env var to set on the target.",
  },
  env_ref_unresolved: {
    title: "Generated env var has no valid source",
    action: "A generated env var references a service/managed id+field that does not exist.",
  },
  env_literal_missing_value: {
    title: "Literal env var has no value",
    action: "An env var marked 'literal' is missing its value.",
  },
  env_literal_secret_shaped: {
    title: "Literal env var looks like a secret",
    action: "A literal env value looks like a credential. Secrets must be supplied as user_secret, never embedded in the plan.",
  },
  managed_provider_missing: {
    title: "Managed service has no provider",
    action: "A managed service set to 'provision' must name a provider.",
  },
  managed_exposes_env_empty: {
    title: "Managed service exposes no env var",
    action: "A managed service must declare the env var it exposes (e.g. DATABASE_URL).",
  },
  provider_unavailable: {
    title: "Provider not available",
    action: "No adapter is registered for this provider in the current build.",
  },
  provider_not_connected: {
    title: "Provider not connected yet",
    action: "Connect this provider's account/key in the Connect step, then deploy.",
  },
  managed_not_connected: {
    title: "Database provider not connected yet",
    action: "Connect this managed provider's account/key, then deploy.",
  },
  service_unsupported_mvp: {
    title: "App type not auto-deployable yet",
    action: "ShipFix currently auto-deploys Vite/static frontends (Vercel), Node APIs (Render), and Postgres (Neon). This service is diagnosed, not deployed.",
  },
  managed_unsupported_mvp: {
    title: "Database type not auto-provisionable yet",
    action: "ShipFix currently provisions Postgres on Neon. Provision other stores manually for now.",
  },
  env_ref_uncovered: {
    title: "Required env var not provided by the plan",
    action: "Add this environment variable to the plan (literal, wiring, or a user secret) before deploying.",
  },
  generated_env_no_wiring: {
    title: "Generated env var has no wiring edge",
    action: "Add a wiring edge so ShipFix can inject this generated value into the target service.",
  },
  user_secret_required: {
    title: "A secret value is required",
    action: "Provide the secret in the setup step. ShipFix never sends secrets to the model.",
  },
  question_needs_secret: {
    title: "Setup answer required",
    action: "Answer the setup question before deploying.",
  },
  migration_required: {
    title: "Database migrations required",
    action:
      "ShipFix runs Prisma migrations automatically. For other migration tools, run them manually after the DB is live, then rerun deploy.",
  },
  backend_health_ungrounded: {
    title: "Backend has no grounded health check",
    action: "Add a health route (e.g. /health returning 2xx) the analyzer can detect, so ShipFix can verify the API is live.",
  },
  provider_servicetype_unsupported: {
    title: "Provider can't deploy this service type",
    action: "The chosen provider's adapter does not support this service type.",
  },
  deploy_adapters_unavailable: {
    title: "Deployment not available in this build",
    action: "No deployment adapters are implemented yet. This is a validated plan proposal, not an executable deployment.",
  },
  managed_provisioning_unavailable: {
    title: "Database/Redis provisioning not available in this build",
    action: "No managed-service provisioners are implemented yet. Provision the resource manually or wait for provisioner support.",
  },
  question_unmapped_service: {
    title: "Question references an unknown service",
    action: "A question blocks a service id that is not in the plan.",
  },
  health_path_unverified: {
    title: "Health check path not verified in repo",
    action: "The plan names a health path but static analysis found no matching routes. ShipFix will verify it as assumed, not proven from code.",
  },
  health_path_ungrounded: {
    title: "Health check path not found in repo routes",
    action: "Pick a path that appears in the detected route list, or confirm the assumed path is correct.",
  },
  health_path_missing: {
    title: "Backend routes found but no healthCheckPath",
    action: "The planner should set healthCheckPath from routeCandidates evidence.",
  },
  verification_path_missing: {
    title: "Backend verification has no path",
    action: "Add healthCheckPath on the backend service and a verification check with a target path.",
  },
  verification_path_unverified: {
    title: "Verification path not verified in repo",
    action: "The verification target is not backed by detected routes; ShipFix will probe it as assumed.",
  },
  verification_path_ungrounded: {
    title: "Verification path not found in repo routes",
    action: "Align the verification target with a detected GET route from the analyzer.",
  },
  verification_path_mismatch: {
    title: "Verification path differs from healthCheckPath",
    action: "Make verification.target and service healthCheckPath consistent.",
  },
};

/** Convert a validation issue into a user-facing Blocker for the plan. */
export function issueToBlocker(issue: ValidationIssue): Blocker {
  const meta = META[issue.code];
  return {
    severity: issue.severity,
    title: meta?.title ?? issue.code,
    explanation: issue.message,
    action: meta?.action ?? "Review the plan; ShipFix flagged this during validation.",
    autoFixable: false,
    evidence: issue.path ? [issue.path] : [],
  };
}

/** True when a blocker title was produced by validatePlan (not the planner). */
export function isValidationBlockerTitle(title: string): boolean {
  return Object.values(META).some((m) => m.title === title);
}
