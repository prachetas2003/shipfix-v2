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

  it("surfaces alpha usage limits clearly", () => {
    const f = translateEvent(ev({ event: "usage_limit_reached", message: "You've reached the alpha usage limit. Try again later." }));
    expect(f.title).toBe("Usage limit reached");
    expect(f.detail.toLowerCase()).toContain("alpha usage limit");
    expect(f.tone).toBe("warn");
  });

  it("surfaces missing backend LLM setup clearly", () => {
    const f = translateEvent(ev({ event: "llm_config_missing", message: "Set GEMINI_API_KEY (preferred) or LLM_API_KEY." }));
    expect(f.title).toBe("Planner setup is missing");
    expect(f.detail).toContain("GEMINI_API_KEY");
    expect(f.tone).toBe("error");
  });
});
