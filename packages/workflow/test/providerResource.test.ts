import { describe, it, expect } from "vitest";
import { stableProviderResourceName } from "../src/providerResource";

describe("stableProviderResourceName", () => {
  it("keys names by ShipFix project and service, not run id", () => {
    const name = stableProviderResourceName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "web");
    expect(name).toBe("sf-aaaaaaaabbbb-web");
    expect(name).not.toContain("run-");
  });

  it("respects provider name length limits", () => {
    const name = stableProviderResourceName("proj-1", "a".repeat(80), 52);
    expect(name.length).toBeLessThanOrEqual(52);
  });

  it("matches deploy activity naming for proj-1/web", () => {
    expect(stableProviderResourceName("proj-1", "web")).toBe("sf-proj1-web");
    expect(stableProviderResourceName("proj-1", "api")).toBe("sf-proj1-api");
  });
});
