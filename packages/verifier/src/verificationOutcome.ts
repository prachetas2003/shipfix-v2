/**
 * Which plan verification checks must pass before ShipFix marks a deploy
 * succeeded vs which are advisory (surfaced in timeline, not blocking).
 */
export const OPTIONAL_VERIFICATION_CHECKS = new Set(["db_connect", "cors_from"]);

export interface PlanVerificationCheck {
  serviceId?: string;
  check?: string;
  target?: string;
}

export function isOptionalVerificationCheck(check: string): boolean {
  return OPTIONAL_VERIFICATION_CHECKS.has(check);
}

export function requiredVerificationChecks(
  checks: PlanVerificationCheck[] | undefined,
): PlanVerificationCheck[] {
  return (checks ?? []).filter((c) => c.check && !isOptionalVerificationCheck(c.check));
}

export interface VerificationAccounting {
  requiredChecks: PlanVerificationCheck[];
  requiredPassed: Set<string>;
  requiredFailed: string[];
  optionalFailed: string[];
  optionalSkipped: string[];
  allRequiredPassed: boolean;
}

function checkKey(serviceId: string, check: string): string {
  return `${serviceId}.${check}`;
}

/** Summarize activity-level verify results for finalizeDeployRun. */
export function accountPlanVerifySummary(
  plan: { verification?: PlanVerificationCheck[] },
  verify: {
    passed: Array<{ serviceId: string; check: string }>;
    failed: Array<{ serviceId: string; check: string }>;
    skipped: Array<{ serviceId: string; check: string; reason: string }>;
  },
): VerificationAccounting {
  const requiredChecks = requiredVerificationChecks(plan.verification);
  const requiredPassed = new Set(
    verify.passed
      .filter((p) => !isOptionalVerificationCheck(p.check))
      .map((p) => checkKey(p.serviceId, p.check)),
  );
  const requiredFailed = verify.failed
    .filter((f) => !isOptionalVerificationCheck(f.check))
    .map((f) => checkKey(f.serviceId, f.check));
  const optionalFailed = verify.failed
    .filter((f) => isOptionalVerificationCheck(f.check))
    .map((f) => checkKey(f.serviceId, f.check));
  const optionalSkipped = verify.skipped
    .filter((s) => isOptionalVerificationCheck(s.check))
    .map((s) => checkKey(s.serviceId, s.check));

  const allRequiredPassed =
    requiredChecks.length === 0 ||
    requiredChecks.every((c) => requiredPassed.has(checkKey(c.serviceId ?? "", c.check ?? "")));

  return {
    requiredChecks,
    requiredPassed,
    requiredFailed,
    optionalFailed,
    optionalSkipped,
    allRequiredPassed,
  };
}

/** Summarize persisted verification events for snapshot layer roll-up. */
export function accountVerificationEvents(
  plan: { verification?: PlanVerificationCheck[] },
  verification: Array<{
    serviceId: string;
    check: string;
    ok: boolean;
    skipped: boolean;
  }>,
): VerificationAccounting {
  const requiredChecks = requiredVerificationChecks(plan.verification);
  const latest = new Map<
    string,
    { serviceId: string; check: string; ok: boolean; skipped: boolean }
  >();
  for (const v of verification) {
    latest.set(checkKey(v.serviceId, v.check), v);
  }

  const requiredPassed = new Set<string>();
  const requiredFailed: string[] = [];
  const optionalFailed: string[] = [];
  const optionalSkipped: string[] = [];

  for (const [key, v] of latest) {
    if (v.skipped) {
      if (isOptionalVerificationCheck(v.check)) optionalSkipped.push(key);
      else requiredFailed.push(key);
      continue;
    }
    if (v.ok) {
      if (!isOptionalVerificationCheck(v.check)) requiredPassed.add(key);
    } else if (isOptionalVerificationCheck(v.check)) {
      optionalFailed.push(key);
    } else {
      requiredFailed.push(key);
    }
  }

  const allRequiredPassed =
    requiredChecks.length === 0 ||
    requiredChecks.every((c) => requiredPassed.has(checkKey(c.serviceId ?? "", c.check ?? "")));

  return {
    requiredChecks,
    requiredPassed,
    requiredFailed,
    optionalFailed,
    optionalSkipped,
    allRequiredPassed,
  };
}
