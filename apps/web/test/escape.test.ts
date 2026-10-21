import { describe, expect, it } from "vitest";
import { escapeFrom } from "../app/components/EscapeHatch";

describe("escapeFrom", () => {
  it("reads an escape plan and ignores a context that has none", () => {
    expect(escapeFrom({ services: [] })).toBeNull();
    expect(escapeFrom({ escape: { source: "replit", platform: "Replit", moves: [] } })?.platform).toBe("Replit");
  });
});
