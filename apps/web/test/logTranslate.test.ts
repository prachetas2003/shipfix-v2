import { describe, it, expect } from "vitest";
import { translateEvent } from "../app/lib/logTranslate";

function ev(data: Record<string, unknown>, message = "", level = "info") {
  return { level, stage: null, type: "log", message, data };
}

describe("translateEvent - failure kinds", () => {
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
    expect(f.title.toLowerCase()).toContain("frontend");
  });

  it("explains a gated (blocked) deploy", () => {
    const f = translateEvent(ev({ event: "deploy_blocked", classification: "needs_setup" }, "Deploy not started - setup is required first."));
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

  it("distinguishes a transient AI provider failure from a usage limit", () => {
    const f = translateEvent(ev({ event: "llm_unavailable", message: "LLM provider temporarily unavailable (HTTP 503)" }));
    expect(f.title).toBe("AI planner temporarily unavailable");
    expect(f.detail.toLowerCase()).toContain("not a usage limit");
    expect(f.tone).toBe("warn");
  });
});

describe("translateEvent - analysis and planning events", () => {
  it("translates repo_clone_started", () => {
    const f = translateEvent(ev({ event: "repo_clone_started", repoFullName: "acme/app" }, "Cloning repository"));
    expect(f.title).toBe("Fetching repository");
    expect(f.tone).toBe("progress");
  });

  it("translates service_detected with role and framework", () => {
    const f = translateEvent(
      ev({ event: "service_detected", service: { role: "backend", framework: "express", rootDir: "server" } }),
    );
    expect(f.title).toContain("backend");
    expect(f.title).toContain("express");
    expect(f.detail).toContain("server");
  });

  it("translates env_refs_detected with a count", () => {
    const f = translateEvent(ev({ event: "env_refs_detected", envRefs: [{ name: "PORT" }, { name: "DATABASE_URL" }] }));
    expect(f.title).toBe("Environment variables detected");
    expect(f.detail).toContain("2");
  });

  it("explains a deterministic plan_generated without AI guesswork", () => {
    const f = translateEvent(ev({ event: "plan_generated", planSource: "deterministic" }));
    expect(f.title).toBe("Deployment plan proposed");
    expect(f.detail.toLowerCase()).toContain("no ai guesswork");
  });

  it("translates plan_downgraded as a warning", () => {
    const f = translateEvent(ev({ event: "plan_downgraded", from: "deployable", to: "needs_setup" }));
    expect(f.title).toBe("Plan adjusted after validation");
    expect(f.tone).toBe("warn");
  });
});

describe("translateEvent - leakage and honesty", () => {
  it("gives a friendly private-repo message for clone failures", () => {
    const f = translateEvent(
      ev({ event: "run_failed", message: 'git clone failed for "acme/private" (exit 128). Details: fatal: could not read' }),
    );
    expect(f.title).toBe("Could not fetch this repository");
    expect(f.detail.toLowerCase()).toContain("public");
  });

  it("never surfaces the raw error in run_failed copy", () => {
    const f = translateEvent(ev({ event: "run_failed", message: "TypeError: cannot read properties of undefined" }));
    expect(f.detail).not.toContain("TypeError");
  });

  it("never surfaces the raw planner error in planning_failed copy", () => {
    const f = translateEvent(ev({ event: "planning_failed", message: "ZodError: invalid_type at services[0]" }));
    expect(f.detail).not.toContain("ZodError");
  });

  it("explains db_connect honestly instead of a misleading skip", () => {
    const f = translateEvent(ev({ event: "verification", check: "db_connect", skipped: true, ok: false }));
    expect(f.detail.toLowerCase()).toContain("provisioned");
    expect(f.tone).toBe("info");
  });

  it("explains a health check that passed on a fallback path", () => {
    const f = translateEvent(
      ev({ event: "verification", check: "health_path", ok: true, statusCode: 200, substitutedPath: "/api/health" }),
    );
    expect(f.detail).toContain("/api/health");
    expect(f.tone).toBe("success");
  });
});
