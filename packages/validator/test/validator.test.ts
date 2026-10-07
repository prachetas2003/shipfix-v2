import { describe, it, expect } from "vitest";
import { DeploymentPlan, RepoContext } from "@shipfix/contracts";
import { validatePlan, capabilities, emptyCapabilities } from "../src/index";

/** A vite(web) + node(api) + postgres app whose plan is fully grounded. */
function makeCtx(): RepoContext {
  return RepoContext.parse({
    repoFullName: "acme/app",
    commitSha: "a".repeat(40),
    fileTree: [
      "web/package.json",
      "web/src/main.tsx",
      "server/package.json",
      "server/src/index.ts",
    ],
    services: [
      {
        rootDir: "web",
        language: "node",
        framework: "vite",
        role: "frontend",
        packageManager: "npm",
        scripts: { build: "vite build", dev: "vite" },
        entrypoints: ["web/src/main.tsx"],
        hasDockerfile: false,
        evidence: ["web/package.json"],
      },
      {
        rootDir: "server",
        language: "node",
        framework: "express",
        role: "backend",
        packageManager: "npm",
        scripts: { build: "tsc", start: "node dist/index.js" },
        entrypoints: ["server/src/index.ts"],
        routeCandidates: [
          { method: "GET", path: "/health", kind: "explicit", evidence: ["server/src/index.ts:6"], score: 40 },
        ],
        hasDockerfile: false,
        evidence: ["server/package.json"],
      },
    ],
    dataNeeds: [
      { kind: "postgres", detectedFrom: "prisma", migrationTool: "prisma", evidence: ["server/prisma/schema.prisma"] },
    ],
    envRefs: [
      { name: "VITE_API_URL", service: "web", required: true },
      { name: "DATABASE_URL", service: "server", required: true },
    ],
    hardcodedUrls: [],
    monorepoTool: "none",
  });
}

function makePlan(): DeploymentPlan {
  return DeploymentPlan.parse({
    goal: "Deploy the web frontend, node API, and provision Postgres.",
    classification: "deployable",
    services: [
      {
        id: "web",
        type: "frontend_static",
        provider: "vercel",
        rootDir: "web",
        install: "npm ci",
        build: "npm run build",
        start: null,
        outputDir: "dist",
        healthCheckPath: null,
        env: [{ name: "VITE_API_URL", source: "generated_from_service", ref: "api.publicUrl" }],
        evidence: ["web/package.json"],
      },
      {
        id: "api",
        type: "node_api",
        provider: "render",
        rootDir: "server",
        install: "npm ci",
        build: "npm run build",
        start: "npm start",
        outputDir: null,
        healthCheckPath: "/health",
        env: [{ name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" }],
        evidence: ["server/package.json"],
      },
    ],
    managed: [
      { id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" },
    ],
    wiring: [
      { fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: "VITE_API_URL" },
      { fromServiceId: "db", fromField: "connectionUrl", toServiceId: "api", toEnvName: "DATABASE_URL" },
    ],
    deployOrder: ["db", "api", "web"],
    questions: [],
    blockers: [],
    verification: [
      { serviceId: "api", check: "health_path", target: "/health" },
      { serviceId: "web", check: "frontend_loads" },
    ],
    confidence: 0.8,
  });
}

const fullCaps = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api", "worker"] },
  ["neon"],
);

const codes = (r: ReturnType<typeof validatePlan>) => r.issues.map((i) => i.code);

describe("validatePlan â grounded plan", () => {
  it("with full capabilities, a grounded plan stays deployable", () => {
    const res = validatePlan(makePlan(), makeCtx(), fullCaps);
    expect(res.issues).toHaveLength(0);
    expect(res.plan.classification).toBe("deployable");
    expect(res.plan.confidence).toBe(0.8);
  });

  it("with NO connected providers, downgrades to needs_setup with clear blockers", () => {
    const res = validatePlan(makePlan(), makeCtx(), emptyCapabilities());
    expect(codes(res)).toContain("provider_not_connected");
    expect(codes(res)).toContain("managed_not_connected");
    expect(res.plan.classification).toBe("needs_setup");
    expect(res.plan.confidence).toBeLessThanOrEqual(0.6);
    // The proposal itself is preserved for the UI.
    expect(res.plan.services).toHaveLength(2);
    expect(res.plan.wiring).toHaveLength(2);
  });
});

describe("validatePlan â grounding against RepoContext", () => {
  it("flags a service rootDir not present in the repo", () => {
    const plan = makePlan();
    plan.services[0].rootDir = "frontend"; // not in ctx
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("service_root_unknown");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("flags a build command that runs a non-existent npm script", () => {
    const plan = makePlan();
    plan.services[0].build = "npm run compile"; // web has no 'compile' script
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("build_command_ungrounded");
  });

  it("does not flag opaque (non-script) commands", () => {
    const plan = makePlan();
    plan.services[1].start = "node dist/index.js"; // opaque, can't disprove
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).not.toContain("start_command_ungrounded");
  });
});

describe("validatePlan â deployOrder", () => {
  it("flags an id missing from deployOrder", () => {
    const plan = makePlan();
    plan.deployOrder = ["db", "api"]; // web missing
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("deploy_order_missing_id");
  });

  it("flags an unknown id in deployOrder", () => {
    const plan = makePlan();
    plan.deployOrder = ["db", "api", "web", "ghost"];
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("deploy_order_unknown_id");
  });
});

describe("validatePlan â wiring", () => {
  it("adds a missing managed env wiring edge without warning when the env ref is valid", () => {
    const plan = makePlan();
    plan.wiring = plan.wiring.filter((w) => w.toEnvName !== "DATABASE_URL");
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).not.toContain("generated_env_no_wiring");
    expect(res.plan.wiring).toContainEqual({
      fromServiceId: "db",
      fromField: "connectionUrl",
      toServiceId: "api",
      toEnvName: "DATABASE_URL",
    });
    expect(res.plan.classification).toBe("deployable");
  });

  it("flags wiring to an unknown service", () => {
    const plan = makePlan();
    plan.wiring[0].toServiceId = "nope";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("wiring_unknown_to");
  });

  it("flags connectionUrl sourced from a non-managed service", () => {
    const plan = makePlan();
    plan.wiring[1].fromServiceId = "api"; // connectionUrl must come from managed
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("wiring_bad_field");
  });
});

describe("validatePlan â env vars", () => {
  it("flags a generated env ref that does not resolve", () => {
    const plan = makePlan();
    plan.services[0].env[0].ref = "api.bogus";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("env_ref_unresolved");
  });

  it("flags a literal env that looks like a secret", () => {
    const plan = makePlan();
    plan.services[1].env.push({ name: "GH_TOKEN", source: "literal", value: `ghp_${"a".repeat(36)}` });
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("env_literal_secret_shaped");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("flags a literal env with no value", () => {
    const plan = makePlan();
    plan.services[1].env.push({ name: "FOO", source: "literal" });
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("env_literal_missing_value");
  });
});

describe("validatePlan â provider capabilities", () => {
  it("flags an unsupported service type for a known provider", () => {
    const caps = capabilities({ vercel: ["frontend_ssr"], render: ["node_api"] }); // web is frontend_static
    const res = validatePlan(makePlan(), makeCtx(), caps);
    expect(codes(res)).toContain("provider_servicetype_unsupported");
  });

  it("treats a supported-but-not-connected provider as needs_setup (YELLOW)", () => {
    const caps = capabilities({ render: ["node_api"] }, ["neon"]); // vercel supported, not connected
    const res = validatePlan(makePlan(), makeCtx(), caps);
    expect(codes(res)).toContain("provider_not_connected");
    expect(codes(res)).not.toContain("provider_unavailable");
    expect(res.plan.classification).toBe("needs_setup");
  });
});

describe("validatePlan â MVP support boundary", () => {
  it("marks an unsupported service type RED (diagnose_only)", () => {
    const plan = makePlan();
    plan.services[0].type = "worker"; // Vercel cannot run background workers
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("service_unsupported_mvp");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("marks an unsupported provider RED (diagnose_only)", () => {
    const plan = makePlan();
    plan.services[1].provider = "railway"; // no MVP support
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("service_unsupported_mvp");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("marks an unsupported managed kind RED (diagnose_only)", () => {
    const plan = makePlan();
    plan.managed[0].kind = "redis"; // neon MVP is postgres only
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("managed_unsupported_mvp");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  describe("Upstash Redis", () => {
    const withRedis = (env: { name: string; ref: string }, serviceId = "api") => {
      const plan = makePlan();
      plan.managed.push({ id: "cache", kind: "redis", mode: "provision", provider: "upstash", exposesEnv: "REDIS_URL", migration: "none" });
      plan.services.find((s) => s.id === serviceId)!.env.push({ name: env.name, source: "generated_from_managed", ref: env.ref });
      plan.wiring.push({ fromServiceId: "cache", fromField: env.ref.split(".")[1] as "restToken", toServiceId: serviceId, toEnvName: env.name });
      plan.deployOrder = ["db", "cache", "api", "web"];
      return plan;
    };
    const redisCaps = capabilities({ vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] }, ["neon", "upstash"]);

    it("accepts connection and REST fields on the server", () => {
      const ctx = makeCtx();
      ctx.envRefs.push({ name: "UPSTASH_REDIS_REST_TOKEN", service: "server", required: true });
      const res = validatePlan(withRedis({ name: "UPSTASH_REDIS_REST_TOKEN", ref: "cache.restToken" }), ctx, redisCaps);
      expect(codes(res)).not.toContain("managed_unsupported_mvp");
      expect(codes(res)).not.toContain("env_ref_unresolved");
      expect(codes(res)).not.toContain("wiring_bad_field");
      expect(res.issues.filter((i) => i.severity === "fatal")).toEqual([]);
      expect(res.plan.classification).toBe("deployable");
    });

    it("asks to connect Upstash when it isn't connected", () => {
      const res = validatePlan(withRedis({ name: "REDIS_URL", ref: "cache.connectionUrl" }), makeCtx(), fullCaps);
      expect(codes(res)).toContain("managed_not_connected");
    });

    it("rejects REST fields on Postgres and credentials in browser code", () => {
      const pgRest = makePlan();
      pgRest.services[1]!.env.push({ name: "X_TOKEN", source: "generated_from_managed", ref: "db.restToken" });
      expect(codes(validatePlan(pgRest, makeCtx(), redisCaps))).toContain("env_ref_unresolved");

      const browser = withRedis({ name: "VITE_REDIS_TOKEN", ref: "cache.restToken" }, "web");
      expect(codes(validatePlan(browser, makeCtx(), redisCaps))).toContain("env_managed_secret_public");
    });
  });

  it("marks Python/FastAPI repo evidence RED even if the plan is optimistic", () => {
    const ctx = makeCtx();
    ctx.services = [
      {
        rootDir: "",
        language: "python",
        framework: "fastapi",
        role: "backend",
        packageManager: "pip",
        scripts: {},
        entrypoints: ["main.py"],
        hasDockerfile: false,
        routeCandidates: [],
        evidence: ["requirements.txt"],
      },
    ];
    const plan = makePlan();
    plan.services = [];
    plan.managed = [];
    plan.wiring = [];
    plan.deployOrder = [];
    const res = validatePlan(plan, ctx, fullCaps);
    expect(codes(res)).toContain("repo_python_unsupported");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("marks Docker-only repo evidence RED", () => {
    const ctx = makeCtx();
    ctx.services = [
      {
        rootDir: "",
        language: "docker",
        framework: "docker",
        role: "unknown",
        packageManager: "none",
        scripts: {},
        entrypoints: ["Dockerfile"],
        hasDockerfile: true,
        routeCandidates: [],
        evidence: ["Dockerfile"],
      },
    ];
    const plan = makePlan();
    plan.services = [];
    plan.managed = [];
    plan.wiring = [];
    plan.deployOrder = [];
    const res = validatePlan(plan, ctx, fullCaps);
    expect(codes(res)).toContain("repo_docker_unsupported");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  describe("Python and Dockerfile services on Render", () => {
    const renderCaps = capabilities({ vercel: ["frontend_static"], render: ["node_api", "python_api", "docker_service"] }, ["neon"]);
    const pythonCtx = (inferredStart?: string) => {
      const ctx = makeCtx();
      ctx.services[1] = {
        rootDir: "server",
        language: "python",
        framework: "fastapi",
        role: "backend",
        packageManager: "pip",
        scripts: {},
        entrypoints: ["server/main.py"],
        hasDockerfile: false,
        routeCandidates: [{ method: "GET", path: "/health", kind: "explicit", evidence: ["server/main.py:9"], score: 39 }],
        ...(inferredStart
          ? { inferredRun: { install: "pip install -r requirements.txt", start: inferredStart, evidence: ["server/main.py:3"] } }
          : {}),
        evidence: ["server/requirements.txt"],
      };
      return ctx;
    };
    const pythonPlan = (start: string) => {
      const plan = makePlan();
      plan.services[1] = { ...plan.services[1], type: "python_api", install: "pip install -r requirements.txt", build: null, start };
      return plan;
    };
    const START = "uvicorn main:app --host 0.0.0.0 --port $PORT";

    it("accepts a python_api whose start command the analyzer inferred", () => {
      const res = validatePlan(pythonPlan(START), pythonCtx(START), renderCaps);
      expect(codes(res)).not.toContain("repo_python_unsupported");
      expect(codes(res)).not.toContain("python_start_ungrounded");
      expect(codes(res)).not.toContain("service_unsupported_mvp");
      expect(res.plan.classification).toBe("deployable");
    });

    it("asks before running a Python start command with no repo evidence", () => {
      const res = validatePlan(pythonPlan("python run.py"), pythonCtx(START), renderCaps);
      expect(codes(res)).toContain("python_start_ungrounded");
      expect(res.plan.classification).toBe("needs_setup");
    });

    it("keeps a Python service RED when the plan doesn't deploy it", () => {
      const plan = makePlan();
      const res = validatePlan(plan, pythonCtx(START), renderCaps);
      expect(codes(res)).toContain("repo_python_unsupported");
    });

    it("requires a Dockerfile for docker_service", () => {
      const ctx = makeCtx();
      ctx.services[1] = { ...ctx.services[1], language: "docker", framework: "docker", role: "backend", hasDockerfile: false };
      const plan = makePlan();
      plan.services[1] = { ...plan.services[1], type: "docker_service", install: null, build: null, start: null };
      expect(codes(validatePlan(plan, ctx, renderCaps))).toContain("docker_file_missing");
      ctx.services[1] = { ...ctx.services[1], hasDockerfile: true };
      const ok = validatePlan(plan, ctx, renderCaps);
      expect(codes(ok)).not.toContain("docker_file_missing");
      expect(codes(ok)).not.toContain("repo_docker_unsupported");
    });
  });

  it("marks SSR setups Vercel can't serve RED, with the fix", () => {
    const ctx = makeCtx();
    ctx.services[0] = { ...ctx.services[0], framework: "sveltekit-node", role: "fullstack" };
    const res = validatePlan(makePlan(), ctx, fullCaps);
    expect(codes(res)).toContain("repo_ssr_unsupported");
    expect(res.issues.find((i) => i.code === "repo_ssr_unsupported")?.message).toContain("adapter-vercel");
    expect(res.plan.classification).toBe("diagnose_only");
  });

  it("does NOT mark Vercel-supported SSR frameworks unsupported", () => {
    for (const framework of ["remix", "nuxt", "react-router", "sveltekit", "tanstack-start"]) {
      const ctx = makeCtx();
      ctx.services[0] = { ...ctx.services[0], framework, role: "fullstack" };
      expect(codes(validatePlan(makePlan(), ctx, fullCaps))).not.toContain("repo_ssr_unsupported");
    }
  });

  it("does NOT mark a Next.js repo unsupported (in the Vercel slice)", () => {
    const ctx = makeCtx();
    ctx.services[0] = { ...ctx.services[0], framework: "next", role: "fullstack" };
    const res = validatePlan(makePlan(), ctx, fullCaps);
    expect(codes(res)).not.toContain("repo_ssr_unsupported");
  });

  it("marks unknown framework repo evidence RED", () => {
    const ctx = makeCtx();
    ctx.services[0] = { ...ctx.services[0], framework: "node", role: "unknown" };
    const res = validatePlan(makePlan(), ctx, fullCaps);
    expect(codes(res)).toContain("repo_unknown_framework");
    expect(res.plan.classification).toBe("diagnose_only");
  });
});

describe("validatePlan â MVP setup blockers (YELLOW)", () => {
  it("allows Prisma migrations (ShipFix runs them) without Yellow", () => {
    const plan = makePlan();
    plan.managed[0].migration = "prisma";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).not.toContain("migration_required");
    expect(res.plan.classification).toBe("deployable");
  });

  it("allows Drizzle migrations (ShipFix runs them) without Yellow", () => {
    const plan = makePlan();
    plan.managed[0].migration = "drizzle";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).not.toContain("migration_required");
    expect(res.plan.classification).toBe("deployable");
  });

  it("still requires setup for alembic migrations (not executed yet)", () => {
    const plan = makePlan();
    plan.managed[0].migration = "alembic";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("migration_required");
    expect(res.plan.classification).toBe("needs_setup");
  });

  it("blocks on an unanswered user secret (needs_setup)", () => {
    const plan = makePlan();
    plan.services[1].env.push({ name: "STRIPE_KEY", source: "user_secret" });
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("user_secret_required");
    expect(res.plan.classification).toBe("needs_setup");
  });

  it("clears user_secret issues when the secret question is satisfied (C2)", () => {
    const plan = makePlan();
    plan.classification = "needs_setup";
    plan.services[1].env.push({ name: "STRIPE_KEY", source: "user_secret" });
    plan.questions.push({
      id: "secret-api-STRIPE_KEY",
      prompt: "Stripe key",
      kind: "secret",
      blocksServiceIds: ["api"],
    });
    // First pass leaves yellow
    const yellow = validatePlan(plan, makeCtx(), fullCaps);
    expect(yellow.plan.classification).toBe("needs_setup");

    const green = validatePlan(plan, makeCtx(), fullCaps, {
      satisfiedSecretQuestionIds: new Set(["secret-api-STRIPE_KEY"]),
    });
    expect(codes(green)).not.toContain("user_secret_required");
    expect(codes(green)).not.toContain("question_needs_secret");
    expect(green.plan.classification).toBe("deployable");
  });

  it("clears user_secret when satisfied via project env name (C2)", () => {
    const plan = makePlan();
    plan.classification = "needs_setup";
    plan.services[1].env.push({ name: "STRIPE_KEY", source: "user_secret" });
    const res = validatePlan(plan, makeCtx(), fullCaps, {
      satisfiedEnvNames: new Set(["STRIPE_KEY"]),
    });
    expect(codes(res)).not.toContain("user_secret_required");
    expect(res.plan.classification).toBe("deployable");
  });

  it("flags a backend whose health path is not grounded (needs_setup)", () => {
    const plan = makePlan();
    plan.services[1].healthCheckPath = "/not-a-real-route";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("backend_health_ungrounded");
    expect(res.plan.classification).toBe("needs_setup");
  });

  it("flags a required repo env var the plan does not provide (needs_setup)", () => {
    const plan = makePlan();
    const ctx = makeCtx();
    ctx.envRefs.push({ name: "SESSION_SECRET", service: "server", required: true });
    const res = validatePlan(plan, ctx, fullCaps);
    expect(codes(res)).toContain("env_ref_uncovered");
    expect(res.plan.classification).toBe("needs_setup");
  });

  it("blocks supported services when required scripts are missing", () => {
    const ctx = makeCtx();
    ctx.services[0].scripts = {};
    ctx.services[1].scripts = { build: "tsc" };
    const plan = makePlan();
    plan.services[0].build = null;
    plan.services[1].start = null;
    const res = validatePlan(plan, ctx, fullCaps);
    expect(codes(res)).toContain("frontend_build_missing");
    expect(codes(res)).toContain("backend_start_missing");
    expect(res.plan.classification).toBe("diagnose_only");
  });
});

describe("validatePlan â preserves planner output", () => {
  it("keeps the planner's blockers and questions, appending validation blockers", () => {
    const plan = makePlan();
    plan.blockers = [
      { severity: "warning", title: "Heads up", explanation: "x", action: "y", autoFixable: false, evidence: [] },
    ];
    plan.questions = [
      { id: "q1", prompt: "Which region?", kind: "choice", options: ["us", "eu"], blocksServiceIds: [] },
    ];
    const res = validatePlan(plan, makeCtx(), emptyCapabilities());
    expect(res.plan.questions).toHaveLength(1);
    expect(res.plan.blockers[0].title).toBe("Heads up"); // original preserved first
    expect(res.plan.blockers.length).toBe(1 + res.issues.length);
  });

  it("never upgrades classification (diagnose_only stays diagnose_only)", () => {
    const plan = makePlan();
    plan.classification = "diagnose_only";
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(res.plan.classification).toBe("diagnose_only");
  });
});

describe("validatePlan  public values and generated secrets", () => {
  const ANON_JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzAwMDAwMDAwfQ.c2lnbmF0dXJlLW5vdC1yZWFs";

  it("accepts a JWT-shaped literal only when it is a verified committed public value", () => {
    const plan = makePlan();
    plan.services[0].env.push({ name: "VITE_SUPABASE_ANON_KEY", source: "literal", value: ANON_JWT });
    expect(codes(validatePlan(plan, makeCtx(), fullCaps))).toContain("env_literal_secret_shaped");

    const ctx = makeCtx();
    ctx.publicEnv = [{ name: "VITE_SUPABASE_ANON_KEY", value: ANON_JWT, file: "web/.env", service: "web" }];
    expect(codes(validatePlan(plan, ctx, fullCaps))).not.toContain("env_literal_secret_shaped");

    plan.services[0].env.push({ name: "SUPABASE_ANON_KEY", source: "literal", value: ANON_JWT });
    expect(codes(validatePlan(plan, ctx, fullCaps))).not.toContain("env_literal_secret_shaped");
  });

  it("allows generated secrets on server names but never on browser-compiled names", () => {
    const plan = makePlan();
    plan.services[1].env.push({ name: "CRON_SECRET", source: "generated_secret" });
    expect(codes(validatePlan(plan, makeCtx(), fullCaps))).not.toContain("env_generated_secret_public");

    plan.services[0].env.push({ name: "VITE_SESSION_SECRET", source: "generated_secret" });
    const res = validatePlan(plan, makeCtx(), fullCaps);
    expect(codes(res)).toContain("env_generated_secret_public");
    expect(res.plan.classification).not.toBe("deployable");
  });
});

describe("validatePlan � integrations", () => {
  const withIntegration = (env: { name: string; source: "integration"; ref: string }, serviceIndex = 1) => {
    const plan = makePlan();
    plan.integrations = [{ id: "supabase", provider: "supabase", projectRef: "abcdefghijklmnopqrst" }];
    plan.services[serviceIndex].env.push(env);
    return plan;
  };
  const connected = capabilities({ vercel: ["frontend_static"], render: ["node_api"] }, ["neon"], ["supabase"]);

  it("rejects refs to undeclared integrations or unknown fields", () => {
    const plan = withIntegration({ name: "X", source: "integration", ref: "stripe.url" });
    expect(codes(validatePlan(plan, makeCtx(), connected))).toContain("env_ref_unresolved");
    const bad = withIntegration({ name: "X", source: "integration", ref: "supabase.password" });
    expect(codes(validatePlan(bad, makeCtx(), connected))).toContain("env_ref_unresolved");
  });

  it("never lets a service-role key reach a browser bundle", () => {
    const plan = withIntegration({ name: "VITE_SUPABASE_SERVICE_ROLE_KEY", source: "integration", ref: "supabase.serviceRoleKey" }, 0);
    expect(codes(validatePlan(plan, makeCtx(), connected))).toContain("env_integration_secret_public");
  });

  it("needs a connection unless the user set every value on the project", () => {
    const plan = withIntegration({ name: "SUPABASE_SERVICE_ROLE_KEY", source: "integration", ref: "supabase.serviceRoleKey" });
    expect(codes(validatePlan(plan, makeCtx(), fullCaps))).toContain("integration_not_connected");
    expect(codes(validatePlan(plan, makeCtx(), connected))).not.toContain("integration_not_connected");
    const selfSet = validatePlan(plan, makeCtx(), fullCaps, { satisfiedEnvNames: new Set(["SUPABASE_SERVICE_ROLE_KEY"]) });
    expect(codes(selfSet)).not.toContain("integration_not_connected");
  });

  it("asks for the project ref until the setup question is answered", () => {
    const plan = withIntegration({ name: "SUPABASE_URL", source: "integration", ref: "supabase.url" });
    plan.integrations![0].projectRef = null;
    expect(codes(validatePlan(plan, makeCtx(), connected))).toContain("integration_project_unknown");
    const answered = validatePlan(plan, makeCtx(), connected, {
      satisfiedSecretQuestionIds: new Set(["integration-supabase-project"]),
    });
    expect(codes(answered)).not.toContain("integration_project_unknown");
  });
});
