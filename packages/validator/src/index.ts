/**
 * @shipfix/validator — deterministic gatekeeper for AI-proposed DeploymentPlans.
 *
 * The planner PROPOSES; this package DISPOSES. It re-checks every claim against
 * RepoContext evidence and the system's real capabilities, downgrades the
 * classification toward `diagnose_only`, and appends user-facing blockers. It
 * never deploys, never executes repo code, and never trusts the model's word.
 */
export { validatePlan, type ValidationResult } from "./validate";
export {
  emptyCapabilities,
  capabilities,
  type Capabilities,
  type ManagedProvider,
} from "./capabilities";
export { issueToBlocker, type ValidationIssue, type IssueSeverity } from "./issues";
export {
  MVP_SERVICE_SUPPORT,
  MVP_MANAGED_SUPPORT,
  MVP_SUPPORT_SUMMARY,
  isServiceTypeSupported,
  isManagedSupported,
} from "./mvpSupport";
