import { describe, it, expect } from "vitest";
import { providersNeedingCredentialFix } from "../app/components/ProviderCredentialFix";
import type { RunEventRow } from "../app/lib/api";

function ev(data: Record<string, unknown>, message = "msg"): RunEventRow {
  return {
    seq: 1,
    type: "log",
    stage: null,
    level: "error",
    message,
    data,
    createdAt: new Date().toISOString(),
  };
}

describe("providersNeedingCredentialFix", () => {
  it("detects setup_blocker on vercel", () => {
    expect(
      providersNeedingCredentialFix([
        ev({ event: "deploy_setup_blocker", provider: "vercel", serviceId: "web" }),
      ]),
    ).toEqual(["vercel"]);
  });

  it("detects misclassified permission deploy_failed", () => {
    expect(
      providersNeedingCredentialFix([
        ev(
          {
            event: "deploy_failed",
            provider: "vercel",
            serviceId: "web",
            detail: "Vercel API HTTP 403: You don't have permission to create the project.",
          },
          'Deploy failed for "web".',
        ),
      ]),
    ).toEqual(["vercel"]);
  });

  it("treats the Vercel GitHub integration error as a Vercel account setup", () => {
    expect(
      providersNeedingCredentialFix([
        ev(
          {
            event: "deploy_failure_guidance",
            action: "inspect_error",
            provider: "vercel",
            whatHappened:
              "ShipFix could not classify this as a clear code bug or a clear credentials problem. Provider error: To link a GitHub repository, you need to install the GitHub integration first.",
          },
          "Vercel could not finish deploying web",
        ),
      ]),
    ).toEqual(["vercel"]);
  });

  it("ignores ordinary build failures", () => {
    expect(
      providersNeedingCredentialFix([
        ev({
          event: "deploy_failed",
          provider: "vercel",
          detail: "Build failed: Module not found",
        }),
      ]),
    ).toEqual([]);
  });
});
