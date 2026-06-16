import { describe, expect, it } from "vitest";
import {
  accountPlanVerifySummary,
  accountVerificationEvents,
  isOptionalVerificationCheck,
} from "../src/verificationOutcome";

describe("verificationOutcome", () => {
  it("treats cors_from and db_connect as optional", () => {
    expect(isOptionalVerificationCheck("cors_from")).toBe(true);
    expect(isOptionalVerificationCheck("db_connect")).toBe(true);
    expect(isOptionalVerificationCheck("health_path")).toBe(false);
    expect(isOptionalVerificationCheck("frontend_loads")).toBe(false);
  });

  it("does not block success when only optional checks fail", () => {
    const plan = {
      verification: [
        { serviceId: "api", check: "health_path", target: "/health" },
        { serviceId: "web", check: "frontend_loads" },
        { serviceId: "api", check: "cors_from", target: "web" },
      ],
    };
    const summary = accountPlanVerifySummary(plan, {
      passed: [
        { serviceId: "api", check: "health_path" },
        { serviceId: "web", check: "frontend_loads" },
      ],
      failed: [{ serviceId: "api", check: "cors_from" }],
      skipped: [],
    });
    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.optionalFailed).toEqual(["api.cors_from"]);
  });

  it("uses the latest verification event per check", () => {
    const plan = {
      verification: [{ serviceId: "api", check: "health_path", target: "/health" }],
    };
    const summary = accountVerificationEvents(plan, [
      { serviceId: "api", check: "health_path", ok: false, skipped: false },
      { serviceId: "api", check: "health_path", ok: true, skipped: false },
    ]);
    expect(summary.allRequiredPassed).toBe(true);
  });
});
