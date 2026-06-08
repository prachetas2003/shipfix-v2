/**
 * @shipfix/verifier — live verification against deployed resources.
 *
 * Plan-driven checks: backend health, frontend loads, CORS/wiring evidence.
 */
export {
  verifyHttpHealth,
  verifyBackends,
  verifyFrontendLoads,
  verifyCorsFrom,
  verifyFromPlan,
  resolveHealthPath,
  type HttpVerifyOptions,
  type HttpVerifyResult,
  type BackendResource,
  type DeployedResource,
  type BackendVerifyOutcome,
  type PlanVerifyOutcome,
} from "./verify";
