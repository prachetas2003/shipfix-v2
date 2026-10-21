import { describe, expect, it } from "vitest";
import { readinessFrom } from "../app/components/LaunchReadiness";

describe("readinessFrom", () => {
  it("reads a score and ignores a context that has no scan", () => {
    expect(readinessFrom({ security: { score: 75, findings: [], historyScanned: false } })?.score).toBe(75);
    expect(readinessFrom({ services: [] })).toBeNull();
    expect(readinessFrom(null)).toBeNull();
  });
});
