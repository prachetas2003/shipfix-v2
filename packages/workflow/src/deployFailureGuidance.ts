import type { DeployFailureKind } from "@shipfix/adapter-core";
import type { PlanService } from "@shipfix/contracts";

/**
 * Unified deploy-failure guidance.
 *
 * ShipFix is a deployment operator: it must name the real problem and tell the
 * user the correct next action. It must NOT default every failure to
 * "paste this into Cursor and fix your repo."
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

/** What the user should actually do next. */
export type DeployUserAction =
  | "fix_repo_code"
  | "update_credentials"
  | "fix_account_setup"
  | "resolve_provider_limit"
  | "resolve_env_conflict"
  | "retry_or_check_logs"
  | "inspect_error";

export interface DeployFailureGuidance {
  action: DeployUserAction;
  failureKind: DeployFailureKind;
  stage: FailingStage | null;
  title: string;
  /** Plain-language explanation of THIS error (not a generic template). */
  whatHappened: string;
  /** Concrete steps for the user. */
  whatYouShouldDo: string[];
  /** Only true when the right fix is editing the repo. */
  showCursorPrompt: boolean;
  /** Present only when showCursorPrompt is true. */
  fixPrompt?: string;
  provider: string;
  serviceId: string;
}

export interface DeployFailureGuidanceInput {
  repoFullName: string;
  service: Pick<PlanService, "id" | "type" | "rootDir" | "install" | "build" | "start" | "healthCheckPath">;
  provider: string;
  failureKind: DeployFailureKind;
  /** Redacted provider/build error tail. */
  errorSummary: string;
}

interface ErrorSignals {
  permission: boolean;
  githubLink: boolean;
  providerLimit: boolean;
  envConflict: boolean;
  build: boolean;
  timeout: boolean;
}

export function detectErrorSignals(errorSummary: string): ErrorSignals {
  const e = errorSummary || "";
  return {
    permission:
      /don't have permission|not authorized|unauthorized|forbidden|invalid token|invalid api key|missing .*apiKey|HTTP 401|HTTP 403|not allowed to create|account\/token permission/i.test(
        e,
      ),
    githubLink:
      /GitHub connection required|Login Connection|git repoId|gitSource.*repoId|requires a linked GitHub|connect.*GitHub/i.test(
        e,
      ),
    providerLimit:
      /too many Vercel projects|repository-connection-limit|cannot be connected to more than|refused to create another project/i.test(
        e,
      ),
    envConflict: /env var conflict|already exists for the target|variable with the name .* already exists/i.test(e),
    build:
      /build[_ ]failed|npm ERR|ELIFECYCLE|Module not found|Cannot find module|TS\d{4}|Type [Ee]rror|failed to compile|SyntaxError|vite.*error|webpack|tsc error|Exited with status [1-9]/i.test(
        e,
      ),
    timeout: /timed out|timeout/i.test(e),
  };
}

function providerLabel(provider: string): string {
  if (provider === "vercel") return "Vercel";
  if (provider === "render") return "Render";
  if (provider === "neon") return "Neon";
  return provider;
}

function shortError(errorSummary: string): string {
  const cleaned = errorSummary.replace(/\s+/g, " ").trim();
  if (!cleaned) return "No detailed error was captured from the provider.";
  return cleaned.length > 280 ? `${cleaned.slice(0, 277)}…` : cleaned;
}

function resolveAction(
  failureKind: DeployFailureKind,
  signals: ErrorSignals,
): DeployUserAction {
  // Prefer concrete signals in the error text over a coarse failureKind —
  // adapters sometimes fall through to deploy_failed.
  if (signals.providerLimit || failureKind === "provider_limit") return "resolve_provider_limit";
  if (signals.envConflict || failureKind === "provider_env_conflict") return "resolve_env_conflict";
  if (signals.githubLink) return "fix_account_setup";
  if (signals.permission || failureKind === "setup_blocker") {
    // setup_blocker without permission text may still be GitHub/account setup
    if (failureKind === "setup_blocker" && !signals.permission && signals.githubLink) {
      return "fix_account_setup";
    }
    if (failureKind === "setup_blocker" && !signals.permission && !signals.githubLink) {
      // Could be either credentials or account setup — prefer credentials update
      // when the message mentions token/key; otherwise account setup.
      return "update_credentials";
    }
    return "update_credentials";
  }
  if (failureKind === "timeout" || signals.timeout) return "retry_or_check_logs";
  if (failureKind === "build_failed" || signals.build) return "fix_repo_code";
  // Generic deploy_failed with no clear build signal: do NOT claim it's a repo bug.
  return "inspect_error";
}

function stageForAction(action: DeployUserAction, failureKind: DeployFailureKind): FailingStage | null {
  switch (action) {
    case "fix_repo_code":
      return failureKind === "build_failed" ? "build" : "deploy";
    case "update_credentials":
    case "fix_account_setup":
    case "resolve_provider_limit":
    case "resolve_env_conflict":
      return "provider_setup";
    case "retry_or_check_logs":
      return "timeout";
    default:
      return "deploy";
  }
}

function expectationFor(service: DeployFailureGuidanceInput["service"]): string {
  if (service.build) {
    return `Make \`${service.build}\` succeed from \`${service.rootDir || "/"}\` with no errors.`;
  }
  return `Make the project build and deploy cleanly from \`${service.rootDir || "/"}\`.`;
}

function buildCursorPrompt(input: DeployFailureGuidanceInput, stage: FailingStage): string {
  const { service, repoFullName, provider, errorSummary } = input;
  const rootDir = service.rootDir || "/";
  return [
    `I'm deploying the repo ${repoFullName} with ShipFix and the deploy failed.`,
    ``,
    `This is a repository code/config problem (not a ShipFix credential issue).`,
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
    `Goal: ${expectationFor(service)}`,
    `Only change what's needed to make the deploy succeed. Do not change unrelated code.`,
  ].join("\n");
}

/**
 * Classify a deploy failure into the correct user action and copy.
 * Always returns guidance — never silently assumes "fix the repo."
 */
export function buildDeployFailureGuidance(input: DeployFailureGuidanceInput): DeployFailureGuidance {
  const signals = detectErrorSignals(input.errorSummary);
  const action = resolveAction(input.failureKind, signals);
  const stage = stageForAction(action, input.failureKind);
  const provider = providerLabel(input.provider);
  const err = shortError(input.errorSummary);
  const serviceId = input.service.id;
  const rootDir = input.service.rootDir || "/";

  switch (action) {
    case "update_credentials":
      return {
        action,
        failureKind: input.failureKind,
        stage,
        title: `${provider} credentials or permissions need updating`,
        whatHappened: `${provider} rejected the deploy for "${serviceId}". ${err}`,
        whatYouShouldDo: [
          `This is not a bug in your application code.`,
          `Update only the ${provider} connection in ShipFix (fresh token${input.provider === "vercel" ? "; include teamId if projects live under a Vercel team" : input.provider === "render" ? "; include ownerId for team accounts if needed" : ""}).`,
          `Then click Retry deploy — you do not need to reconnect other providers.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };

    case "fix_account_setup":
      return {
        action,
        failureKind: input.failureKind,
        stage,
        title: `${provider} account setup is incomplete`,
        whatHappened: `${provider} blocked "${serviceId}" because the account is missing a required link or setting. ${err}`,
        whatYouShouldDo: [
          `This is not a repository code bug.`,
          input.provider === "vercel"
            ? `Connect GitHub to your Vercel account (Login Connections) and authorize the Vercel GitHub app for this repo.`
            : `Check ${provider} account access to the GitHub repo, then retry.`,
          `If the token is for a team, update credentials with the correct team/owner id.`,
          `Then retry deploy in ShipFix.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };

    case "resolve_provider_limit":
      return {
        action,
        failureKind: input.failureKind,
        stage,
        title: `${provider} project limit for this repo`,
        whatHappened: `${provider} refused to attach another project to this GitHub repo. ${err}`,
        whatYouShouldDo: [
          `This is a ${provider} account limit, not a code bug.`,
          `Delete unused ${provider} projects linked to this repo, or reuse an existing project.`,
          `Then retry deploy in ShipFix.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };

    case "resolve_env_conflict":
      return {
        action,
        failureKind: input.failureKind,
        stage,
        title: `${provider} environment variable conflict`,
        whatHappened: `${provider} could not set an environment variable for "${serviceId}". ${err}`,
        whatYouShouldDo: [
          `This is a provider-side env conflict, not an app source bug.`,
          `Retry deploy (ShipFix will try to replace the variable), or remove the conflicting env var in the ${provider} project settings.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };

    case "retry_or_check_logs":
      return {
        action,
        failureKind: input.failureKind,
        stage,
        title: `${provider} deploy timed out`,
        whatHappened: `ShipFix stopped waiting for "${serviceId}" on ${provider}. ${err}`,
        whatYouShouldDo: [
          `Check the ${provider} dashboard — the deploy may still finish or show a build error.`,
          `If the build is stuck or very slow, that can be a repo/script issue; if ${provider} is just slow, retry deploy.`,
          `Other live services (database/backend) are left as-is.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };

    case "fix_repo_code": {
      const fixStage = stage ?? "build";
      return {
        action,
        failureKind: input.failureKind,
        stage: fixStage,
        title: `Repo build/config failed on ${provider}`,
        whatHappened: `${provider} failed while building or starting "${serviceId}" from \`${rootDir}\`. ${err}`,
        whatYouShouldDo: [
          `This looks like a problem in the repository (scripts, dependencies, or TypeScript/config) — not a ShipFix credential issue.`,
          `Reproduce locally from \`${rootDir}\`${input.service.build ? ` with \`${input.service.build}\`` : ""}.`,
          `Fix the code, commit and push to ${input.repoFullName}, then retry Deploy.`,
          `You can paste the prompt below into Cursor or ChatGPT to help fix the repo.`,
        ],
        showCursorPrompt: true,
        fixPrompt: buildCursorPrompt(input, fixStage),
        provider: input.provider,
        serviceId,
      };
    }

    case "inspect_error":
    default:
      return {
        action: "inspect_error",
        failureKind: input.failureKind,
        stage,
        title: `${provider} could not finish deploying "${serviceId}"`,
        whatHappened: `ShipFix could not classify this as a clear code bug or a clear credentials problem. Provider error: ${err}`,
        whatYouShouldDo: [
          `Read the error above carefully.`,
          `If it mentions permissions, tokens, teams, or GitHub access → update the ${provider} connection (not your app code).`,
          `If it mentions build, compile, missing modules, or TypeScript → fix the repo, then push and retry.`,
          `If it is unclear, open the ${provider} dashboard for the full log before changing code.`,
        ],
        showCursorPrompt: false,
        provider: input.provider,
        serviceId,
      };
  }
}

/** @deprecated Use buildDeployFailureGuidance. Kept for older imports/tests. */
export type RepoFixGuidance = {
  stage: FailingStage;
  summary: string;
  checklist: string[];
  fixPrompt: string;
};

/** @deprecated Use buildDeployFailureGuidance. Returns null unless action is fix_repo_code. */
export function buildRepoFixGuidance(
  input: DeployFailureGuidanceInput,
): RepoFixGuidance | null {
  const g = buildDeployFailureGuidance(input);
  if (!g.showCursorPrompt || !g.fixPrompt || !g.stage) return null;
  return {
    stage: g.stage,
    summary: g.whatHappened,
    checklist: g.whatYouShouldDo,
    fixPrompt: g.fixPrompt,
  };
}
