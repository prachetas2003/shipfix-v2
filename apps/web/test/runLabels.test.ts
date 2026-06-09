import { describe, expect, it } from "vitest";
import { runModeLabel, runStatusLabel } from "../app/lib/runLabels";

describe("run labels", () => {
  it("uses product wording for plan and deploy runs", () => {
    expect(runStatusLabel("plan", "succeeded")).toBe("Plan ready");
    expect(runStatusLabel("deploy", "succeeded")).toBe("Deploy succeeded");
    expect(runStatusLabel("deploy", "failed")).toBe("Deploy failed");
    expect(runModeLabel("plan")).toBe("Plan run");
    expect(runModeLabel("deploy")).toBe("Deploy run");
  });
});
