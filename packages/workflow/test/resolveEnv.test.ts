import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { DeploymentPlan, PlanService } from "@shipfix/contracts";
import { createSecretVault } from "@shipfix/secrets";
import { resolveServiceEnv } from "../src/resolveEnv";

const apiService: PlanService = {
  id: "api",
  type: "node_api",
  provider: "render",
  rootDir: "apps/api",
  install: null,
  build: null,
  start: null,
  outputDir: null,
  healthCheckPath: "/health",
  env: [{ name: "DATABASE_URL", source: "generated_from_managed", ref: "db.connectionUrl" }],
  evidence: [],
};

const webService: PlanService = {
  id: "web",
  type: "frontend_static",
  provider: "vercel",
  rootDir: "apps/web",
  install: null,
  build: null,
  start: null,
  outputDir: "dist",
  healthCheckPath: null,
  env: [{ name: "VITE_API_URL", source: "generated_from_service", ref: "api.publicUrl" }],
  evidence: [],
};

const plan: DeploymentPlan = {
  goal: "x",
  classification: "deployable",
  services: [apiService, webService],
  managed: [{ id: "db", kind: "postgres", mode: "provision", provider: "neon", exposesEnv: "DATABASE_URL", migration: "none" }],
  wiring: [{ fromServiceId: "api", fromField: "publicUrl", toServiceId: "web", toEnvName: "VITE_API_URL" }],
  deployOrder: ["db", "api", "web"],
  questions: [],
  blockers: [],
  verification: [],
  confidence: 1,
};

describe("resolveServiceEnv", () => {
  it("resolves DATABASE_URL from a sealed managed resource", async () => {
    const vault = createSecretVault(randomBytes(32));
    const secret = "postgres://u:p@ep.neon.tech/db?sslmode=require";
    const sealed = await vault.seal(secret);

    const { env, issues } = await resolveServiceEnv(
      apiService,
      plan,
      [
        {
          serviceId: "db",
          status: "live",
          url: null,
          exposesEnv: "DATABASE_URL",
          encBlob: sealed.encBlob,
          encIv: sealed.encIv,
          encDek: sealed.encDek,
        },
      ],
      vault,
    );

    expect(issues).toHaveLength(0);
    expect(env.DATABASE_URL).toBe(secret);
  });

  it("resolves pooled URL from sealed Neon JSON payload", async () => {
    const vault = createSecretVault(randomBytes(32));
    const payload = JSON.stringify({
      pooled: "postgres://u:p@ep-pooler.neon.tech/db",
      direct: "postgres://u:p@ep.neon.tech/db",
    });
    const sealed = await vault.seal(payload);

    const { env, issues } = await resolveServiceEnv(
      apiService,
      plan,
      [
        {
          serviceId: "db",
          status: "live",
          url: null,
          exposesEnv: "DATABASE_URL",
          encBlob: sealed.encBlob,
          encIv: sealed.encIv,
          encDek: sealed.encDek,
        },
      ],
      vault,
    );

    expect(issues).toHaveLength(0);
    expect(env.DATABASE_URL).toBe("postgres://u:p@ep-pooler.neon.tech/db");
  });

  it("resolves Upstash TCP and REST fields from one sealed secret", async () => {
    const vault = createSecretVault(randomBytes(32));
    const sealed = await vault.seal(
      JSON.stringify({ url: "rediss://default:pw@h.upstash.io:6379", restUrl: "https://h.upstash.io", restToken: "tok" }),
    );
    const redisApi: PlanService = {
      ...apiService,
      env: [
        { name: "REDIS_URL", source: "generated_from_managed", ref: "cache.connectionUrl" },
        { name: "KV_REST_API_URL", source: "generated_from_managed", ref: "cache.restUrl" },
        { name: "KV_REST_API_TOKEN", source: "generated_from_managed", ref: "cache.restToken" },
      ],
    };
    const redisPlan: DeploymentPlan = {
      ...plan,
      services: [redisApi],
      managed: [{ id: "cache", kind: "redis", mode: "provision", provider: "upstash", exposesEnv: "REDIS_URL", migration: "none" }],
    };
    const row = { serviceId: "cache", status: "live", url: "h.upstash.io", exposesEnv: "REDIS_URL", ...sealed };
    const { env, issues } = await resolveServiceEnv(redisApi, redisPlan, [row], vault);
    expect(issues).toHaveLength(0);
    expect(env).toEqual({
      REDIS_URL: "rediss://default:pw@h.upstash.io:6379",
      KV_REST_API_URL: "https://h.upstash.io",
      KV_REST_API_TOKEN: "tok",
    });

    const pgRest = { ...apiService, env: [{ name: "T", source: "generated_from_managed" as const, ref: "db.restToken" }] };
    const pgRow = { serviceId: "db", status: "live", url: null, exposesEnv: "DATABASE_URL", ...(await vault.seal("postgres://x")) };
    const res = await resolveServiceEnv(pgRest, plan, [pgRow], vault);
    expect(res.issues.map((i) => i.code)).toEqual(["unsupported_source"]);
  });

  it("reports missing managed resource without exposing secrets", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(apiService, plan, [], vault);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(issues[0]?.code).toBe("missing_managed");
  });

  it("resolves generated_from_service publicUrl from deployed service row", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(
      webService,
      plan,
      [
        {
          serviceId: "api",
          status: "live",
          url: "https://api.onrender.com",
          exposesEnv: null,
          encBlob: null,
          encIv: null,
          encDek: null,
        },
      ],
      vault,
    );
    expect(issues).toHaveLength(0);
    expect(env.VITE_API_URL).toBe("https://api.onrender.com");
  });

  it("resolves generated_from_service origin field", async () => {
    const vault = createSecretVault(randomBytes(32));
    const svc: PlanService = {
      ...webService,
      env: [{ name: "API_ORIGIN", source: "generated_from_service", ref: "api.origin" }],
    };
    const { env, issues } = await resolveServiceEnv(
      svc,
      plan,
      [
        {
          serviceId: "api",
          status: "live",
          url: "https://api.onrender.com/health",
          exposesEnv: null,
          encBlob: null,
          encIv: null,
          encDek: null,
        },
      ],
      vault,
    );
    expect(issues).toHaveLength(0);
    expect(env.API_ORIGIN).toBe("https://api.onrender.com");
  });

  it("defers frontend origin refs when the frontend is not live yet", async () => {
    const vault = createSecretVault(randomBytes(32));
    const apiWithCors: PlanService = {
      ...apiService,
      env: [
        ...apiService.env,
        { name: "CORS_ORIGIN", source: "generated_from_service", ref: "web.origin" },
      ],
    };
    const planWithCors: DeploymentPlan = {
      ...plan,
      services: [apiWithCors, webService],
    };
    const { env, issues, deferred } = await resolveServiceEnv(
      apiWithCors,
      planWithCors,
      [],
      vault,
      { deferFrontendOrigins: true },
    );
    expect(issues.some((i) => i.envName === "CORS_ORIGIN")).toBe(false);
    expect(deferred).toContain("CORS_ORIGIN");
    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it("resolves user_secret from run_inputs by question id", async () => {
    const vault = createSecretVault(randomBytes(32));
    const apiWithSecret: PlanService = {
      ...apiService,
      env: [{ name: "STRIPE_SECRET_KEY", source: "user_secret" }],
    };
    const { env, issues } = await resolveServiceEnv(
      apiWithSecret,
      plan,
      [],
      vault,
      {
        runInputValues: new Map([["secret-api-STRIPE_SECRET_KEY", "sk_test_123"]]),
      },
    );
    expect(issues).toHaveLength(0);
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_123");
  });

  it("resolves user_secret from project env when run_inputs are empty", async () => {
    const vault = createSecretVault(randomBytes(32));
    const apiWithSecret: PlanService = {
      ...apiService,
      env: [{ name: "STRIPE_SECRET_KEY", source: "user_secret" }],
    };
    const { env, issues } = await resolveServiceEnv(apiWithSecret, plan, [], vault, {
      projectEnvValues: new Map([["STRIPE_SECRET_KEY", "sk_project_456"]]),
    });
    expect(issues).toHaveLength(0);
    expect(env.STRIPE_SECRET_KEY).toBe("sk_project_456");
  });

  it("prefers run_inputs over project env for the same secret", async () => {
    const vault = createSecretVault(randomBytes(32));
    const apiWithSecret: PlanService = {
      ...apiService,
      env: [{ name: "STRIPE_SECRET_KEY", source: "user_secret" }],
    };
    const { env, issues } = await resolveServiceEnv(apiWithSecret, plan, [], vault, {
      runInputValues: new Map([["secret-api-STRIPE_SECRET_KEY", "sk_run"]]),
      projectEnvValues: new Map([["STRIPE_SECRET_KEY", "sk_project"]]),
    });
    expect(issues).toHaveLength(0);
    expect(env.STRIPE_SECRET_KEY).toBe("sk_run");
  });

  it("reports missing_secret when user_secret is unanswered", async () => {
    const vault = createSecretVault(randomBytes(32));
    const apiWithSecret: PlanService = {
      ...apiService,
      env: [{ name: "STRIPE_SECRET_KEY", source: "user_secret" }],
    };
    const { issues } = await resolveServiceEnv(apiWithSecret, plan, [], vault);
    expect(issues[0]?.code).toBe("missing_secret");
  });
});

describe("generated secrets", () => {
  const cronService: PlanService = {
    ...apiService,
    env: [
      { name: "CRON_SECRET", source: "generated_secret" },
      { name: "AUTH_SECRET", source: "generated_secret" },
    ],
  };
  const cronPlan: DeploymentPlan = { ...plan, services: [cronService, webService] };

  it("resolves generated secrets from project env values and reports missing ones", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(cronService, cronPlan, [], vault, {
      projectEnvValues: new Map([["CRON_SECRET", "generated-value"]]),
    });
    expect(env.CRON_SECRET).toBe("generated-value");
    expect(issues).toEqual([{ code: "missing_secret", envName: "AUTH_SECRET" }]);
  });

  it("lists names to generate once across services and makes strong values", async () => {
    const { generatedSecretNames, newGeneratedSecret } = await import("../src/generatedSecrets");
    const shared: DeploymentPlan = {
      ...cronPlan,
      services: [cronService, { ...webService, id: "worker", env: [{ name: "CRON_SECRET", source: "generated_secret" }] }],
    };
    expect(generatedSecretNames(shared)).toEqual(["AUTH_SECRET", "CRON_SECRET"]);
    const a = newGeneratedSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newGeneratedSecret()).not.toBe(a);
  });
});

describe("integration env", () => {
  const supaService: PlanService = {
    ...apiService,
    env: [
      { name: "SUPABASE_URL", source: "integration", ref: "supabase.url" },
      { name: "SUPABASE_SERVICE_ROLE_KEY", source: "integration", ref: "supabase.serviceRoleKey" },
    ],
  };
  const supaPlan: DeploymentPlan = {
    ...plan,
    services: [supaService, webService],
    integrations: [{ id: "supabase", provider: "supabase", projectRef: null }],
  };

  it("prefers a project override, then the connected project, else reports it missing", async () => {
    const vault = createSecretVault(randomBytes(32));
    const { env, issues } = await resolveServiceEnv(supaService, supaPlan, [], vault, {
      projectEnvValues: new Map([["SUPABASE_URL", "https://override.example"]]),
      integrationValues: new Map([["supabase.url", "https://ref.supabase.co"]]),
    });
    expect(env.SUPABASE_URL).toBe("https://override.example");
    expect(issues).toEqual([{ code: "missing_secret", envName: "SUPABASE_SERVICE_ROLE_KEY" }]);
  });

  it("reads values from the connected Supabase account, using the answered project ref", async () => {
    const { resolveIntegrationValues } = await import("../src/integrationValues");
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify([{ name: "anon", api_key: "anon-key" }, { name: "service_role", api_key: "service-key" }]), { status: 200 });
    }) as typeof fetch;
    const { values, problems } = await resolveIntegrationValues(
      supaPlan,
      new Map([["supabase", { accessToken: "sbp_x" }]]),
      new Map([["integration-supabase-project", "answeredrefxxxxxxxxx"]]),
      { fetchImpl },
    );
    expect(problems).toEqual([]);
    expect(seen[0]).toContain("/projects/answeredrefxxxxxxxxx/api-keys");
    expect(Object.fromEntries(values)).toEqual({
      "supabase.url": "https://answeredrefxxxxxxxxx.supabase.co",
      "supabase.projectRef": "answeredrefxxxxxxxxx",
      "supabase.anonKey": "anon-key",
      "supabase.serviceRoleKey": "service-key",
    });

    const notConnected = await resolveIntegrationValues(supaPlan, new Map(), new Map());
    expect(notConnected.values.size).toBe(0);
    expect(notConnected.problems[0]).toMatch(/not connected/);
  });
});
