import { describe, expect, it } from "vitest";
import { extractFailureGuidance } from "../app/components/FailureGuidance";
import type { RunEventRow } from "../app/lib/api";

const row = (data: Record<string, unknown>, message = ""): RunEventRow =>
  ({ id: 1, seq: 1, type: "log", stage: null, level: "info", message, data, createdAt: "" }) as unknown as RunEventRow;

describe("extractFailureGuidance with autofix", () => {
  const guidance = row({ event: "deploy_failure_guidance", action: "fix_repo_code", title: "Fix the build", fixPrompt: "p", showCursorPrompt: true });

  it("hides stale guidance once a fix was pushed", () => {
    expect(extractFailureGuidance([guidance, row({ event: "repair_pushed" })])).toBeNull();
  });

  it("shows guidance again when the redeploy fails afterwards", () => {
    expect(extractFailureGuidance([guidance, row({ event: "repair_pushed" }), guidance])?.title).toBe("Fix the build");
  });

  it("hides stale guidance once ShipFix is asking a question", () => {
    expect(extractFailureGuidance([guidance, row({ event: "question" })])).toBeNull();
  });

  it("turns an unpushable tested fix into a copyable prompt", () => {
    const g = extractFailureGuidance([guidance, row({ event: "repair_push_unavailable", fixPrompt: "Apply this tested fix" }, "no access")]);
    expect(g).toMatchObject({ title: "ShipFix found and tested a fix", fixPrompt: "Apply this tested fix", showCursorPrompt: true });
  });
});
