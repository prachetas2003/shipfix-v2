import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo, createLocalFsRepoSource } from "../src/index";
import { detectPublicEnv, isSafePublicValue } from "../src/publicEnv";

const FIXTURE = fileURLToPath(new URL("./fixtures/lovable-supabase", import.meta.url));
const FULL_CAPS = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] },
  ["neon"],
);
const ANON_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbCIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.c2lnbmF0dXJlLW5vdC1yZWFs";
const SERVICE_ROLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbCIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.c2lnbmF0dXJlLW5vdC1yZWFs";

function memorySource(files: Record<string, string>) {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (p: string) => files[p] ?? null,
  };
}

describe("public env values", () => {
  it("accepts public config and rejects credentials and placeholders", () => {
    expect(isSafePublicValue("https://abcdefghijkl.supabase.co")).toBe(true);
    expect(isSafePublicValue(ANON_JWT)).toBe(true);
    expect(isSafePublicValue("sb_publishable_abc123")).toBe(true);
    expect(isSafePublicValue(SERVICE_ROLE_JWT)).toBe(false);
    expect(isSafePublicValue("sb_secret_abc123")).toBe(false);
    expect(isSafePublicValue("sk_live_abc")).toBe(false);
    expect(isSafePublicValue("postgres://u:pw@host/db")).toBe(false);
    expect(isSafePublicValue("your-project-url")).toBe(false);
    expect(isSafePublicValue("")).toBe(false);
  });

  it("reads only public-prefixed names from committed env files, per service", async () => {
    const values = await detectPublicEnv(
      memorySource({
        ".env": "VITE_A=root\nSECRET_TOKEN=abc\n",
        "apps/web/.env": "NEXT_PUBLIC_A='web' # comment\nexport NEXT_PUBLIC_B=\"b\"\n",
        "apps/web/.env.production": "NEXT_PUBLIC_A=prod\n",
        "apps/web/.env.example": "NEXT_PUBLIC_C=real-looking\n",
        "apps/web/.env.local": "NEXT_PUBLIC_D=local\n",
      }),
      new Set([".env", "apps/web/.env", "apps/web/.env.production", "apps/web/.env.example", "apps/web/.env.local"]),
      ["", "apps/web"],
    );
    expect(values.map((v) => `${v.service}:${v.name}=${v.value}`)).toEqual([
      ":VITE_A=root",
      "apps/web:NEXT_PUBLIC_A=prod",
      "apps/web:NEXT_PUBLIC_B=b",
    ]);
  });
});

describe("Lovable + Supabase app", () => {
  it("uses committed Supabase public values and never surfaces the service-role key", async () => {
    const ctx = await analyzeRepo(createLocalFsRepoSource(FIXTURE), {
      repoFullName: "fixtures/lovable-supabase",
      commitSha: "0".repeat(40),
    });
    expect(ctx.publicEnv.map((v) => v.name)).toEqual([
      "VITE_SUPABASE_PROJECT_ID",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_URL",
    ]);
    expect(JSON.stringify(ctx)).not.toContain(SERVICE_ROLE_JWT);
    expect(JSON.stringify(ctx)).not.toContain("sk_live_");

    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.questions).toEqual([]);
    expect(plan?.services[0].env).toEqual(
      expect.arrayContaining([
        { name: "VITE_SUPABASE_URL", source: "literal", value: "https://abcdefghijkl.supabase.co" },
        { name: "VITE_SUPABASE_PUBLISHABLE_KEY", source: "literal", value: ANON_JWT },
      ]),
    );
    const result = validatePlan(plan!, ctx, FULL_CAPS);
    expect(result.issues).toEqual([]);
    expect(result.plan.classification).toBe("deployable");
  });
});

describe("Supabase project detection", () => {
  const REF = "abcdefghijklmnopqrst";
  const pkg = JSON.stringify({ scripts: { build: "vite build" }, dependencies: { "@supabase/supabase-js": "2" }, devDependencies: { vite: "5" } });
  const analyzeFiles = (files: Record<string, string>) =>
    analyzeRepo(memorySource({ "package.json": pkg, ...files }), { repoFullName: "t/t", commitSha: "0".repeat(40) });

  it("reads the project ref from config.toml, committed env, or a hardcoded client URL", async () => {
    expect((await analyzeFiles({ "supabase/config.toml": `project_id = "${REF}"\n` })).supabase?.projectRef).toBe(REF);
    expect((await analyzeFiles({ ".env": `VITE_SUPABASE_URL=https://${REF}.supabase.co\n` })).supabase?.projectRef).toBe(REF);
    expect(
      (await analyzeFiles({ "src/integrations/supabase/client.ts": `const SUPABASE_URL = "https://${REF}.supabase.co";` })).supabase
        ?.projectRef,
    ).toBe(REF);
  });

  it("does not mistake a CLI project name for a ref, and is absent for non-Supabase apps", async () => {
    const named = await analyzeFiles({ "supabase/config.toml": 'project_id = "my-app"\n' });
    expect(named.supabase).toEqual(expect.objectContaining({ projectRef: null }));
    const plain = await analyzeRepo(memorySource({ "package.json": JSON.stringify({ devDependencies: { vite: "5" } }) }), {
      repoFullName: "t/t",
      commitSha: "0".repeat(40),
    });
    expect(plain.supabase).toBeUndefined();
  });
});

describe("Supabase-hosted Postgres", () => {
  it("does not ask ShipFix to provision Postgres for a Supabase project's tooling deps", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        scripts: { dev: "vite", build: "vite build" },
        dependencies: { "@supabase/supabase-js": "2", "drizzle-orm": "0.30", postgres: "3", react: "18", "react-dom": "18" },
        devDependencies: { vite: "5", "drizzle-kit": "0.20" },
      }),
      "package-lock.json": "{}",
      "drizzle.config.ts": "export default { dialect: 'postgresql' }",
      "supabase/config.toml": "project_id = \"x\"",
      "src/main.tsx": "const u = import.meta.env.VITE_SUPABASE_URL;",
    };
    const ctx = await analyzeRepo(memorySource(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
    expect(ctx.dataNeeds).toEqual([expect.objectContaining({ kind: "postgres", hostedBy: "supabase", migrationTool: "none" })]);
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.managed).toEqual([]);
    expect(plan?.services.map((s) => s.type)).toEqual(["frontend_static"]);
  });

  it("keeps the need when deployed code reads a database URL", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ scripts: { start: "node index.js" }, dependencies: { "@supabase/supabase-js": "2", pg: "8", express: "4" } }),
      "index.js": "new Pool({ connectionString: process.env.DATABASE_URL })",
    };
    const ctx = await analyzeRepo(memorySource(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
    expect(ctx.dataNeeds[0].hostedBy).toBeUndefined();
  });
});

describe("env ref noise and fallbacks", () => {
  it("drops platform/dev noise, skips tests, and marks fallback refs optional", async () => {
    const { detectEnvAndUrls } = await import("../src/env");
    const files: Record<string, string> = {
      "src/server.ts": [
        "const a = process.env.NEXT_RUNTIME;",
        "const b = process.env.NEXT_PUBLIC_VERCEL_ENV;",
        "const c = process.env.REPLIT_DEV_DOMAIN;",
        "const d = process.env.npm_package_version;",
        "const e = process.env.LOG_LEVEL ?? 'info';",
        "const f = process.env.STRIPE_SECRET_KEY;",
        "const g = process.env.NEXT_PUBLIC_BASE_URL;",
      ].join("\n"),
      "src/server.test.ts": "process.env.TEST_ONLY_TOKEN;",
    };
    const { envRefs } = await detectEnvAndUrls(memorySource(files), new Set(Object.keys(files)), [""]);
    expect(envRefs.map((r) => `${r.name}:${r.required}`).sort()).toEqual([
      "LOG_LEVEL:false",
      "NEXT_PUBLIC_BASE_URL:true",
      "STRIPE_SECRET_KEY:true",
    ]);
  });
});
