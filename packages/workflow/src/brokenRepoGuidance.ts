import type { DeployFailureKind } from "@shipfix/adapter-core";
import type { PlanService } from "@shipfix/contracts";

/**
 * ShipFix is a DEPLOYMENT OPERATOR, not a code fixer. When a repo fails to
 * build/deploy because of the repo's own code or config, ShipFix stops, names
 * the failing stage, and hands the user a copy-pasteable fix prompt plus a short
 * manual checklist — but it NEVER mutates the repo or auto-commits a fix.
 */
export type FailingStage =
  | "install"
  | "build"
  | "start"
  | "health_check"
  | "env"
  | "provider_setup"
  | "deploy"
  | "timeout";

export interface RepoFixGuidance {
  stage: FailingStage;
  /** One-line beginner explanation of what happened. */
  summary: string;
  /** Short manual checklist the user can act on. */
  checklist: string[];
  /** Copy-pasteable prompt for Cursor/ChatGPT to fix the repo. */
  fixPrompt: string;
}

export interface RepoFixInput {
  repoFullName: string;
  service: Pick<PlanService, "id" | "type" | "rootDir" | "install" | "build" | "start" | "healthCheckPath">;
  provider: string;
  failureKind: DeployFailureKind;
  /** Redacted provider/build error tail. */
  errorSummary: string;
}

function stageForFailure(failureKind: DeployFailureKind): FailingStage {
  switch (failureKind) {
    case "build_failed":
      return "build";
    case "timeout":
      return "timeout";
    case "setup_blocker":
    case "provider_limit":
    case "provider_env_conflict":
      return "provider_setup";
    default:
      return "deploy";
  }
}

function expectationFor(stage: FailingStage, service: RepoFixInput["service"]): string {
  switch (stage) {
    case "build":
      return service.build
        ? `Make \`${service.build}\` succeed from \`${service.rootDir || "/"}\` with no errors.`
        : `Make the project build cleanly from \`${service.rootDir || "/"}\`.`;
    case "start":
      return service.start
        ? `Make \`${service.start}\` boot the server and bind to the provider's $PORT.`
        : `Make the service start and listen on the provider's $PORT.`;
    case "health_check":
      return `Add a health route at \`${service.healthCheckPath || "/health"}\` that returns HTTP 2xx.`;
    case "timeout":
      return `Make the build finish well under the provider's time limit (trim install/build steps).`;
    default:
      return `Make the service deploy cleanly on ${"the provider"}.`;
  }
}

/**
 * Build copy-pasteable repo-fix guidance for a failed deploy. Returns null for
 * provider-setup failures (those are a connection problem, not a repo bug).
 */
export function buildRepoFixGuidance(input: RepoFixInput): RepoFixGuidance | null {
  const stage = stageForFailure(input.failureKind);
  if (stage === "provider_setup") return null; // not a repo issue — handled by setup_blocker copy
  if (input.failureKind === "provider_limit") return null;
  if (input.failureKind === "provider_env_conflict") return null;

  const { service, repoFullName, provider, errorSummary } = input;
  const rootDir = service.rootDir || "/";
  const expectation = expectationFor(stage, service);

  const summary =
    stage === "timeout"
      ? `Deploying "${service.id}" timed out before the build finished. This is usually a slow or stuck build in the repo — ShipFix does not change your code.`
      : `Deploying "${service.id}" failed during the ${stage} stage. This looks like an issue in the repo's code or config — ShipFix does not change your code.`;

  const checklist: string[] = [
    `Open the technical details for the exact ${provider} error.`,
    stage === "build"
      ? `Run the build locally from ${rootDir}: \`${service.build ?? "npm run build"}\` and fix any errors.`
      : `Reproduce the failure locally from ${rootDir} and fix it.`,
    `Confirm dependencies are committed (lockfile present) and Node version is compatible.`,
  ];
  if (service.type === "node_api") {
    checklist.push(`Ensure the server listens on \`process.env.PORT\` and exposes a 2xx health route.`);
  }
  checklist.push(`Commit and push the fix to ${repoFullName}, then rerun Deploy in ShipFix.`);

  const fixPrompt = [
    `I'm deploying the repo ${repoFullName} with ShipFix and the deploy failed.`,
    ``,
    `Failing stage: ${stage}`,
    `Service: ${service.id} (${service.type}) on ${provider}`,
    `Root directory: ${rootDir}`,
    `Install command: ${service.install ?? "(none)"}`,
    `Build command: ${service.build ?? "(none)"}`,
    `Start command: ${service.start ?? "(none)"}`,
    service.healthCheckPath ? `Health path: ${service.healthCheckPath}` : `Health path: (none)`,
    ``,
    `Error summary from the provider:`,
    errorSummary.slice(0, 1500) || "(no detail captured)",
    ``,
    `Goal: ${expectation}`,
    `Only change what's needed to make the deploy succeed. Do not change unrelated code.`,
  ].join("\n");

  return { stage, summary, checklist, fixPrompt };
}
