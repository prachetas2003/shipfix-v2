/**
 * Translate raw run_events into beginner-friendly timeline entries: what
 * happened, whether anything is live, and what the user should do next.
 * The original technical message is preserved for expandable details.
 */

export type FriendlyTone = "info" | "success" | "warn" | "error" | "progress";

export interface FriendlyEvent {
  title: string;
  detail: string;
  tone: FriendlyTone;
  /** True when this entry confirms something is live with a URL. */
  isLive?: boolean;
  url?: string | null;
}

interface RawEvent {
  level: string;
  stage: string | null;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function serviceRole(serviceId: string | null, provider: string | null): "frontend" | "backend" | "database" | "service" {
  if (provider === "vercel" || serviceId === "web" || serviceId === "frontend") return "frontend";
  if (provider === "render" || serviceId === "api" || serviceId === "backend") return "backend";
  if (provider === "neon" || serviceId === "db" || serviceId === "database") return "database";
  return "service";
}

/** Map a single run_event to a friendly summary. Falls back to the raw message. */
export function translateEvent(ev: RawEvent): FriendlyEvent {
  const d = ev.data ?? {};
  const event = typeof d.event === "string" ? d.event : null;
  const serviceId = str(d.serviceId) ?? str(d.managedId);
  const provider = str(d.provider);
  const role = serviceRole(serviceId, provider);

  switch (event) {
    case "usage_limit_reached":
      return {
        title: "Usage limit reached",
        detail: str(d.message) ??
          "You've reached the alpha usage limit. Try again later, or raise the local alpha limits while testing.",
        tone: "warn",
      };
    case "llm_unavailable":
      return {
        title: "AI planner temporarily unavailable",
        detail:
          "The AI model behind the planner is briefly overloaded or unreachable. This is not a usage limit — wait a minute and retry the run.",
        tone: "warn",
      };
    case "llm_config_missing":
      return {
        title: "Planner setup is missing",
        detail: str(d.message) ??
          "ShipFix needs backend-only LLM settings in the API or worker environment before it can generate plans.",
        tone: "error",
      };
    case "planning_failed":
      return {
        title: "Planning failed",
        detail:
          "ShipFix could not generate a deployment plan for this repo. Open technical details for the planner error, then try again.",
        tone: "error",
      };
    case "run_failed": {
      const message = str(d.message) ?? "";
      if (/git clone failed/i.test(message)) {
        return {
          title: "Could not fetch this repository",
          detail:
            "This repo looks private or does not exist. ShipFix supports public GitHub repos right now — check the name, or make the repo public and try again.",
          tone: "error",
        };
      }
      return {
        title: "Run failed",
        detail: "The run stopped before it could finish. Open technical details for the underlying error.",
        tone: "error",
      };
    }
    case "internal_control_plane_consistency_error":
      return {
        title: "Worker could not find this run",
        detail:
          "ShipFix started a worker task, but the worker could not find the run record. This usually means API and worker are connected to different databases.",
        tone: "error",
      };
    case "workflow_starting":
      return {
        title: "Starting deployment worker",
        detail: "ShipFix created the run and is asking Temporal to start the workflow.",
        tone: "progress",
      };
    case "workflow_started":
      return {
        title: "Deployment workflow started",
        detail: "Temporal accepted the workflow. A ShipFix worker should pick it up from the task queue next.",
        tone: "info",
      };
    case "internal_workflow_start_failed":
      return {
        title: "Workflow did not start",
        detail:
          "ShipFix created the run, but Temporal did not accept the workflow. Start Temporal and the worker, then retry.",
        tone: "error",
      };
    case "internal_workflow_start_missing":
      return {
        title: "Workflow start was not recorded",
        detail:
          "ShipFix queued the run, but no workflow start was recorded. Start Temporal or check the API Temporal configuration, then retry.",
        tone: "error",
      };
    case "internal_worker_not_polling":
      return {
        title: "Worker did not pick up the run",
        detail:
          "ShipFix queued the run, but the worker did not pick it up. Start the worker or check Temporal/task queue configuration.",
        tone: "error",
      };
    case "internal_validation_stalled":
      return {
        title: "Plan validation stalled inside ShipFix",
        detail:
          "ShipFix finalized this run so it would not stay validating forever. Restart API and worker, then start a new plan/deploy.",
        tone: "error",
      };
    case "planning_started":
      return {
        title: "Starting deployment plan",
        detail: "ShipFix finished repository analysis and is moving into plan generation.",
        tone: "progress",
      };
    case "plan_generation_started":
      return {
        title: "Generating deployment plan",
        detail: "ShipFix is turning the detected services, database needs, and environment variables into a deploy plan.",
        tone: "progress",
      };
    case "plan_generation_completed":
      return {
        title: "Deployment plan generated",
        detail: "ShipFix generated a plan and is ready to validate it against the supported deployment lane.",
        tone: "info",
      };
    case "internal_plan_transition_failed":
      return {
        title: "Planning did not start",
        detail:
          "ShipFix analyzed the repo, but the workflow did not enter plan generation. Restart the API and worker and check that they use the same database and Temporal task queue.",
        tone: "error",
      };
    case "internal_plan_generation_failed":
      return {
        title: "Plan generation failed inside ShipFix",
        detail:
          "ShipFix could not generate the deployment plan. Check the worker logs and LLM configuration, then retry.",
        tone: "error",
      };
    case "internal_plan_generation_stalled":
      return {
        title: "Plan generation stalled",
        detail:
          "ShipFix started plan generation but did not record a plan or planner error. Restart the API and worker, then retry.",
        tone: "error",
      };
    case "repo_clone_started":
      return {
        title: "Fetching repository",
        detail: "ShipFix is downloading the repo to analyze it. Nothing is executed from the repo.",
        tone: "progress",
      };
    case "repo_clone_completed":
      return { title: "Repository fetched", detail: "The repo was downloaded and pinned to a commit.", tone: "success" };
    case "service_detected": {
      const svc = (d.service ?? {}) as Record<string, unknown>;
      const svcRole = str(svc.role) ?? "service";
      const framework = str(svc.framework) ?? "unknown framework";
      const root = str(svc.rootDir) || "repo root";
      return {
        title: `Found a ${svcRole === "unknown" ? "" : `${svcRole} `}service: ${framework}`,
        detail: `Located at ${root}. ShipFix will plan around the services it actually found.`,
        tone: "info",
      };
    }
    case "env_refs_detected": {
      const refs = Array.isArray(d.envRefs) ? d.envRefs.length : null;
      return {
        title: "Environment variables detected",
        detail:
          refs === 0
            ? "No environment variables are referenced by the code."
            : `The code references ${refs ?? "some"} environment variable(s). ShipFix wires what it can and asks for the rest — values are never sent to the AI model.`,
        tone: "info",
      };
    }
    case "plan_generated": {
      const source = str(d.planSource);
      return {
        title: "Deployment plan proposed",
        detail:
          source === "deterministic"
            ? "This repo fits the supported stack, so the plan was built directly from repo evidence — no AI guesswork involved."
            : "The AI planner proposed a plan from the repo evidence. ShipFix validates every claim before anything deploys.",
        tone: "info",
      };
    }
    case "plan_downgraded":
      return {
        title: "Plan adjusted after validation",
        detail:
          "Validation found items the plan can't safely auto-deploy yet, so the run delivers a diagnosis/setup list instead of guessing.",
        tone: "warn",
      };
    case "analysis_completed":
      return { title: "Repository analyzed", detail: "ShipFix detected the app structure and deployment signals.", tone: "success" };
    case "plan_reused":
      return { title: "Using selected plan", detail: "This deploy is continuing from the validated plan you chose.", tone: "info" };
    case "plan_validated":
      return { title: "Deployment plan ready", detail: "ShipFix validated what can be deployed and what setup is needed.", tone: "success" };
    case "neon_config_check":
      return {
        title: "Checking Neon organization setup",
        detail: Boolean(d.orgIdAvailable)
          ? "Neon organization ID is available for database provisioning."
          : "Neon organization ID is missing, so ShipFix will not call Neon.",
        tone: Boolean(d.orgIdAvailable) ? "success" : "warn",
      };
    case "provision_started":
      return {
        title: provider === "neon" ? "Creating Neon database" : "Creating managed database",
        detail: "ShipFix is provisioning the database before deploying the backend.",
        tone: "progress",
      };
    case "provision_log":
      return { title: "Database provider update", detail: ev.message, tone: "info" };
    case "provision_failed":
      return {
        title: "Database was not created",
        detail: "The backend needs the database URL, so ShipFix stopped before deploying dependent services.",
        tone: "error",
      };
    case "resource_provisioned":
      return {
        title: "Database is ready",
        detail: "Neon created the database and ShipFix sealed the connection string for backend wiring.",
        tone: "success",
        isLive: true,
        url: str(d.host),
      };
    case "deploy_started":
      return {
        title:
          role === "backend"
            ? "Deploying backend to Render"
            : role === "frontend"
              ? "Deploying frontend to Vercel"
              : `Deploying ${serviceId ?? "service"}`,
        detail:
          role === "backend"
            ? "Render is installing dependencies, building the API, and starting the service."
            : role === "frontend"
              ? "Vercel is building the frontend with the backend URL wired in."
              : "The provider is building and deploying this service.",
        tone: "progress",
      };
    case "deploy_log":
      return { title: "Provider build log", detail: ev.message, tone: "info" };
    case "service_deployed":
      return {
        title:
          role === "backend"
            ? "Backend API is live"
            : role === "frontend"
              ? "Frontend app is live"
              : "Service is live",
        detail: provider ? `Deployed on ${providerName(provider)} and reachable.` : "Deployed and reachable.",
        tone: "success",
        isLive: true,
        url: str(d.publicUrl),
      };
    case "deploy_setup_blocker":
      return {
        title: role === "frontend" ? "Vercel needs GitHub access" : "Provider setup needs attention",
        detail:
          "The deploy stopped because a provider account needs setup. Fix the provider connection and retry deploy.",
        tone: "warn",
      };
    case "deploy_provider_limit":
      return {
        title: "Vercel project limit reached for this repo",
        detail:
          "Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects. Delete old Vercel projects or reuse an existing project.",
        tone: "warn",
      };
    case "deploy_needs_credential":
      return {
        title: "Provider connection missing",
        detail: "Connect the required provider account, then retry deploy.",
        tone: "warn",
      };
    case "deploy_env_blocked": {
      const diagnosis = d.diagnosis as { action?: string; evidence?: { issues?: string[] } } | undefined;
      const issues = diagnosis?.evidence?.issues ?? (Array.isArray(d.issues) ? d.issues.map(String) : []);
      return {
        title:
          role === "backend"
            ? "The backend is waiting for a required env value"
            : role === "frontend"
              ? "The frontend is waiting for a required env value"
              : "A required environment value is not ready",
        detail:
          diagnosis?.action ??
          (issues.includes("missing_secret")
            ? "A secret is missing. Answer the plan question or set it on the app Environment page."
            : "ShipFix did not deploy this service because a dependency was not available yet."),
        tone: "warn",
      };
    }
    case "deploy_skipped":
      return { title: "Step skipped", detail: humanizeRawMessage(ev.message), tone: "info" };
    case "deploy_failed": {
      const kind = str(d.failureKind);
      if (kind === "provider_limit") {
        return {
          title: "Vercel project limit reached for this repo",
          detail:
            "Vercel refused to create another project for this GitHub repo because the repo is already connected to too many Vercel projects. Delete old Vercel projects or reuse an existing project.",
          tone: "warn",
        };
      }
      if (kind === "build_failed") {
        return {
          title: role === "backend" ? "Render could not build the backend" : "Provider could not build the service",
          detail:
            "The provider build failed. This is usually a repo script, dependency, or TypeScript/config issue. Open technical details for the log tail.",
          tone: "error",
        };
      }
      if (kind === "timeout") {
        return {
          title: "Deploy timed out",
          detail:
            "The provider took longer than ShipFix waited. Check the provider dashboard or retry deploy to reconcile the result.",
          tone: "error",
        };
      }
      return {
        title: role === "frontend" ? "Vercel could not deploy the frontend" : "Service did not deploy",
        detail: "The deployment did not complete. Open technical details to see the provider error.",
        tone: "error",
      };
    }
    case "deploy_fix_guidance":
      return {
        title: "Suggested repo fix",
        detail: ev.message,
        tone: "warn",
      };
    case "deploy_blocked":
      return {
        title: "Deploy not started",
        detail: humanizeRawMessage(ev.message),
        tone: "warn",
      };
    case "deploy_timeout":
      return {
        title: "Frontend deploy timed out on Vercel",
        detail:
          "The frontend did not finish deploying in time. Backend and database may still be live. Check Vercel or retry deploy.",
        tone: "error",
      };
    case "verification": {
      const check = str(d.check) ?? "check";
      const ok = Boolean(d.ok);
      const skipped = Boolean(d.skipped);
      const code = typeof d.statusCode === "number" ? ` (HTTP ${d.statusCode})` : "";
      const diagnosis = d.diagnosis as { action?: string; code?: string } | undefined;
      if (skipped) {
        if (check === "db_connect") {
          return {
            title: "Database connection check",
            detail: "Database reachability was already proven when the database was provisioned (SELECT 1 succeeded).",
            tone: "info",
          };
        }
        return { title: `Check skipped: ${friendlyCheck(check)}`, detail: "Not enough was live to run this check.", tone: "info" };
      }
      const substituted = str(d.substitutedPath);
      return {
        title: `${friendlyCheck(check)} ${ok ? "passed" : "failed"}${code}`,
        detail: ok
          ? substituted
            ? `The planned health path did not respond, but the backend answered at ${substituted} (a route detected in the repo). Consider adding a dedicated /health route.`
            : verificationSuccessDetail(check)
          : diagnosis?.action ??
            "ShipFix could not prove this part is live. Open technical details for the failed check.",
        tone: ok ? "success" : "error",
        url: str(d.url),
      };
    }
    case "migration_failed": {
      const diagnosis = d.diagnosis as { action?: string } | undefined;
      return {
        title: "Database migration failed",
        detail: diagnosis?.action ?? humanizeRawMessage(ev.message),
        tone: "error",
      };
    }
    case "recovery_attempt":
      return {
        title: "Trying automatic recovery",
        detail: "ShipFix is re-wiring backend CORS origins and will re-check the live system.",
        tone: "info",
      };
    case "recovery_succeeded":
      return {
        title: "Recovery succeeded",
        detail: "Verification passed after ShipFix rewired the backend origins.",
        tone: "success",
      };
    case "recovery_exhausted":
    case "recovery_skipped":
      return {
        title: "Automatic recovery did not fix the issue",
        detail: "Review the failed verification checks below and apply the suggested fix.",
        tone: "warn",
      };
    case "verify_skipped":
      return { title: "Verification skipped", detail: humanizeRawMessage(ev.message), tone: "info" };
    default:
      break;
  }

  if (ev.stage) {
    return { title: stageTitle(ev.stage), detail: humanizeRawMessage(ev.message), tone: stageTone(ev.level, ev.stage) };
  }
  return { title: humanizeRawMessage(ev.message), detail: "", tone: stageTone(ev.level, ev.stage) };
}

function providerName(provider: string): string {
  if (provider === "vercel") return "Vercel";
  if (provider === "render") return "Render";
  if (provider === "neon") return "Neon";
  return provider;
}

function friendlyCheck(check: string): string {
  switch (check) {
    case "health_path":
    case "http_2xx":
      return "Backend health check";
    case "frontend_loads":
      return "Frontend loaded";
    case "cors_from":
      return "Frontend to backend connection";
    case "db_connect":
      return "Database connection check";
    default:
      return check;
  }
}

function verificationSuccessDetail(check: string): string {
  if (check === "health_path" || check === "http_2xx") return "The backend responded successfully at its health endpoint.";
  if (check === "frontend_loads") return "The frontend page loaded from the deployed URL.";
  if (check === "cors_from") return "The frontend can reach the backend origin.";
  if (check === "db_connect") return "ShipFix connected to the database and ran SELECT 1.";
  return "Live evidence confirmed.";
}

function stageTitle(stage: string): string {
  const map: Record<string, string> = {
    queued: "Queued",
    cloning: "Fetching repository",
    analyzing: "Analyzing repository",
    planning: "Generating deployment plan",
    provisioning: "Creating database",
    deploying: "Deploying services",
    verifying: "Verifying live app",
    succeeded: "Your app is live",
    diagnosed: "Deployment needs attention",
    failed: "Deploy failed",
  };
  return map[stage] ?? humanizeRawMessage(stage);
}

function stageTone(level: string, stage?: string | null): FriendlyTone {
  if (level === "error" || stage === "failed") return "error";
  if (level === "warn" || stage === "diagnosed") return "warn";
  if (stage === "succeeded") return "success";
  if (["cloning", "analyzing", "planning", "provisioning", "deploying", "verifying"].includes(stage ?? "")) return "progress";
  return "info";
}

function humanizeRawMessage(message: string): string {
  return message
    .replace(/\benv resolution blocked\b/gi, "a required environment value is not ready")
    .replace(/\bworkflow activity failed\b/gi, "the deployment worker stopped this step")
    .replace(/\bprovision_failed\b/gi, "database provisioning failed")
    .replace(/\bdeploy_log\b/gi, "provider log");
}
