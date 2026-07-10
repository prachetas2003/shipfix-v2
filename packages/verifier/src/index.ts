/**
 * @shipfix/verifier — live verification against deployed resources.
 *
 * Plan-driven checks: backend health, frontend loads, CORS/wiring evidence,
 * and database connectivity.
 */
export {
  verifyHttpHealth,
  verifyBackends,
  verifyFrontendLoads,
  verifyCorsFrom,
  verifyFromPlan,
  resolveHealthPath,
  type HttpVerifyOptions,
  type PlanVerifyOptions,
  type HttpVerifyResult,
  type BackendResource,
  type DeployedResource,
  type BackendVerifyOutcome,
  type PlanVerifyOutcome,
} from "./verify";
export {
  diagnosisFromVerifyOutcome,
  diagnosisForMigrationFailure,
  diagnosisForEnvUnresolved,
} from "./diagnosis";
export {
  OPTIONAL_VERIFICATION_CHECKS,
  isOptionalVerificationCheck,
  requiredVerificationChecks,
  accountPlanVerifySummary,
  accountVerificationEvents,
  type PlanVerificationCheck,
  type VerificationAccounting,
} from "./verificationOutcome";
