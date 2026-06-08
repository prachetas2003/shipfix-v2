import { describe, it, expect } from "vitest";
import { translateEvent } from "../app/lib/logTranslate";

function ev(data: Record<string, unknown>, message = "", level = "info") {
  return { level, stage: null, type: "log", message, data };
}

describe("translateEvent — failure kinds", () => {
  it("distinguishes a build failure from a generic failure", () => {
    const f = translateEvent(ev({ event: "deploy_failed", serviceId: "api", failureKind: "build_failed" }));
    expect(f.title.toLowerCase()).toContain("build");
    expect(f.tone).toBe("error");
  });

  it("distinguishes a timeout", () => {
    const f = translateEvent(ev({ event: "deploy_failed", serviceId: "web", failureKind: "timeout" }));
    expect(f.title.toLowerCase()).toContain("timed out");
  });

  it("falls back to a generic deploy failure", () => {
    const f = translateEvent(ev({ event: "deploy_failed", serviceId: "web", failureKind: "deploy_failed" }));
    expect(f.title.toLowerCase()).toContain("did not deploy");
  });

  it("explains a gated (blocked) deploy", () => {
    const f = translateEvent(ev({ event: "deploy_blocked", classification: "needs_setup" }, "Deploy not started — setup is required first."));
    expect(f.title).toBe("Deploy not started");
    expect(f.tone).toBe("warn");
  });

  it("explains a frontend deploy timeout on Vercel", () => {
    const f = translateEvent(
      ev(
        { event: "deploy_timeout", serviceId: "web", failureKind: "timeout", provider: "vercel" },
        "Frontend \"web\" deployment timed out on Vercel.",
      ),
    );
    expect(f.title.toLowerCase()).toContain("timed out");
    expect(f.tone).toBe("error");
  });

  it("surfaces repo fix guidance as a warning", () => {
    const f = translateEvent(ev({ event: "deploy_fix_guidance", serviceId: "api", stage: "build" }, "Deploying \"api\" failed during the build stage."));
    expect(f.title.toLowerCase()).toContain("fix");
    expect(f.tone).toBe("warn");
  });
});
