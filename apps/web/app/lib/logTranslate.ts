/**
 * Translate raw run_events into beginner-friendly timeline entries: what
 * happened, whether anything is live, and what (if anything) the user must do.
 * The original technical message is preserved for an expandable details view.
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

/** Map a single run_event to a friendly summary. Falls back to the raw message. */
export function translateEvent(ev: RawEvent): FriendlyEvent {
  const d = ev.data ?? {};
  const event = typeof d.event === "string" ? d.event : null;
  const serviceId = str(d.serviceId);
  const provider = str(d.provider);

  switch (event) {
    case "analysis_completed":
      return { title: "Repository analyzed", detail: "ShipFix read your repo and detected its structure.", tone: "success" };
    case "plan_validated":
      return { title: "Deployment plan ready", detail: "ShipFix proposed and validated a plan for your app.", tone: "success" };
    case "resource_provisioned":
      return {
        title: `Database ready${provider ? ` (${provider})` : ""}`,
        detail: "A managed database was provisioned and its connection string is sealed for wiring.",
        tone: "success",
        isLive: true,
        url: str(d.host),
      };
    case "deploy_started":
      return {
        title: `Deploying ${serviceId ?? "service"}${provider ? ` to ${provider}` : ""}`,
        detail: "Building and shipping this service to the provider.",
        tone: "progress",
      };
    case "deploy_log":
      return { title: "Build log", detail: ev.message, tone: "info" };
    case "service_deployed":
      return {
        title: `${serviceId ?? "Service"} is live`,
        detail: `Deployed to ${provider ?? "provider"} and reachable.`,
        tone: "success",
        isLive: true,
        url: str(d.publicUrl),
      };
    case "deploy_setup_blocker":
      return {
        title: `${serviceId ?? "Service"} needs provider setup`,
        detail:
          "The deploy stopped because a provider account needs setup (often connecting GitHub to Vercel). Fix the connection and rerun Deploy.",
        tone: "warn",
      };
    case "deploy_needs_credential":
      return {
        title: "A provider key is missing",
        detail: "Connect the required provider, then rerun Deploy.",
        tone: "warn",
      };
    case "deploy_env_blocked":
      return {
        title: `Can't deploy ${serviceId ?? "service"} yet`,
        detail: "A required value from another service isn't available yet (for example the backend URL).",
        tone: "warn",
      };
    case "deploy_skipped":
      return { title: "Step skipped", detail: ev.message, tone: "info" };
    case "deploy_failed": {
      const kind = str(d.failureKind);
      if (kind === "build_failed") {
        return {
          title: `${serviceId ?? "Service"} failed to build`,
          detail:
            "The provider could not build this service from your repo (install/build/start failed). This is usually a code or config issue in the repo — see technical details and the suggested fix.",
          tone: "error",
        };
      }
      if (kind === "timeout") {
        return {
          title: `${serviceId ?? "Service"} timed out while deploying`,
          detail:
            "The build ran longer than ShipFix waited. It may still finish at the provider — rerun Deploy to reconcile, or check the provider dashboard.",
          tone: "error",
        };
      }
      return {
        title: `${serviceId ?? "Service"} did not deploy`,
        detail: "The deployment did not complete. Open technical details to see the provider error.",
        tone: "error",
      };
    }
    case "deploy_fix_guidance":
      return {
        title: "Suggested fix for the repo",
        detail: ev.message,
        tone: "warn",
      };
    case "deploy_blocked":
      return {
        title: "Deploy not started",
        detail: ev.message,
        tone: "warn",
      };
    case "deploy_timeout":
      return {
        title: `${serviceId ?? "Frontend"} timed out on Vercel`,
        detail:
          "The frontend did not finish deploying in time. Your backend and database may still be live — check Vercel or rerun Deploy.",
        tone: "error",
      };
    case "verification": {
      const check = str(d.check) ?? "check";
      const ok = Boolean(d.ok);
      const skipped = Boolean(d.skipped);
      const code = typeof d.statusCode === "number" ? ` (HTTP ${d.statusCode})` : "";
      if (skipped) {
        return { title: `Check skipped: ${friendlyCheck(check)}`, detail: "Not enough was live to run this check.", tone: "info" };
      }
      return {
        title: `${friendlyCheck(check)}: ${ok ? "passed" : "failed"}${code}`,
        detail: ok ? "Live evidence confirmed." : "This check did not pass — see technical details.",
        tone: ok ? "success" : "error",
        url: str(d.url),
      };
    }
    case "verify_skipped":
      return { title: "Verification skipped", detail: ev.message, tone: "info" };
    default:
      break;
  }

  // Stage transitions and generic events.
  if (ev.stage) {
    return { title: stageTitle(ev.stage), detail: ev.message, tone: stageTone(ev.level) };
  }
  return { title: ev.message, detail: "", tone: stageTone(ev.level) };
}

function friendlyCheck(check: string): string {
  switch (check) {
    case "health_path":
    case "http_2xx":
      return "Backend health check";
    case "frontend_loads":
      return "Frontend loads";
    case "cors_from":
      return "Frontend↔backend connection (CORS)";
    case "db_connect":
      return "Database connectivity";
    default:
      return check;
  }
}

function stageTitle(stage: string): string {
  const map: Record<string, string> = {
    queued: "Queued",
    cloning: "Fetching repository",
    analyzing: "Analyzing repository",
    planning: "Generating plan",
    provisioning: "Provisioning database",
    deploying: "Deploying services",
    verifying: "Verifying live app",
    succeeded: "App is live",
    diagnosed: "Partly live — needs attention",
    failed: "Deploy failed",
  };
  return map[stage] ?? stage;
}

function stageTone(level: string): FriendlyTone {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  return "info";
}
