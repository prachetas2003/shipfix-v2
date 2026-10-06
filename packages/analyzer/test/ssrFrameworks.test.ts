import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo } from "../src/index";

function repo(files: Record<string, string | object>) {
  const text = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  return {
    listFiles: async () => Object.keys(text),
    readFile: async (p: string) => text[p] ?? null,
  };
}

async function analyze(files: Record<string, string | object>) {
  return analyzeRepo(repo(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
}

const caps = capabilities({ vercel: ["frontend_static", "frontend_ssr"], render: ["node_api"] }, ["neon"], ["supabase"]);

function app(deps: Record<string, string>, extra: Record<string, string | object> = {}) {
  return {
    "package.json": { name: "app", scripts: { dev: "vite dev", build: "vite build" }, dependencies: { react: "19", "react-dom": "19", ...deps }, devDependencies: { vite: "7" } },
    "package-lock.json": "{}",
    ...extra,
  };
}

describe("server-rendered frameworks built with Vite", () => {
  it("deploys a Lovable TanStack Start app as a server-rendered Vercel app, not a static site", async () => {
    const ctx = await analyze(
      app(
        { "@tanstack/react-start": "1", nitro: "3", "@lovable.dev/vite-tanstack-config": "2" },
        {
          "src/routes/api/notion/read.ts": "const key = process.env.NOTION_API_KEY;",
          "src/router.tsx": "export const x = 1;",
        },
      ),
    );
    expect(ctx.services.map((s) => `${s.framework}/${s.role}`)).toEqual(["tanstack-start/fullstack"]);

    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.services).toMatchObject([{ type: "frontend_ssr", provider: "vercel", framework: "tanstack-start", outputDir: null }]);
    expect(plan.goal).toContain("TanStack Start app on Vercel");

    const { issues } = validatePlan(plan, ctx, caps);
    expect(issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("refuses TanStack Start without Nitro and says what to add", async () => {
    const ctx = await analyze(app({ "@tanstack/react-start": "1" }));
    expect(ctx.services[0]).toMatchObject({ framework: "tanstack-start-node", role: "fullstack" });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("tells SvelteKit adapters apart", async () => {
    const kit = (adapter: string) => analyze(app({ "@sveltejs/kit": "2", [adapter]: "1", svelte: "5" }));
    expect((await kit("@sveltejs/adapter-auto")).services[0]).toMatchObject({ framework: "sveltekit", role: "fullstack" });
    expect((await kit("@sveltejs/adapter-node")).services[0]).toMatchObject({ framework: "sveltekit-node", role: "fullstack" });

    const staticCtx = await kit("@sveltejs/adapter-static");
    expect(staticCtx.services[0]).toMatchObject({ framework: "sveltekit-static", role: "frontend" });
    expect(synthesizeDeterministicPlan(staticCtx)?.services[0]).toMatchObject({ type: "frontend_static", outputDir: "build" });
  });

  it("leaves apps built for Cloudflare out of the Vercel path", async () => {
    const rr = await analyze(app({ "@react-router/dev": "7", wrangler: "4" }));
    expect(rr.services[0]).toMatchObject({ framework: "cloudflare-worker", role: "worker" });
    const remix = await analyze(app({ "@remix-run/react": "2", "@remix-run/cloudflare": "2" }));
    expect(remix.services[0]).toMatchObject({ framework: "remix-cloudflare", role: "fullstack" });
    expect(synthesizeDeterministicPlan(remix)).toBeNull();
  });

  it("plans Upstash for Redis clients that read their env implicitly", async () => {
    const ctx = await analyze({
      "package.json": { name: "app", scripts: { build: "next build" }, dependencies: { next: "15", "@upstash/redis": "1" } },
      "package-lock.json": "{}",
      "lib/redis.ts": 'import { Redis } from "@upstash/redis";\nexport const redis = Redis.fromEnv();',
    });
    expect(ctx.envRefs.map((r) => r.name)).toEqual(["UPSTASH_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL"]);
    expect(ctx.dataNeeds.map((d) => d.kind)).toEqual(["redis"]);
    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.managed).toMatchObject([{ id: "cache", kind: "redis", provider: "upstash" }]);
    expect(plan.services[0]!.env.map((e) => e.ref)).toEqual(["cache.restToken", "cache.restUrl"]);
  });

  it("recognizes React Router framework mode", async () => {
    const ctx = await analyze(app({ "react-router": "7", "@react-router/dev": "7" }));
    expect(ctx.services[0]).toMatchObject({ framework: "react-router", role: "fullstack" });
    expect(synthesizeDeterministicPlan(ctx)?.services[0]).toMatchObject({ type: "frontend_ssr", framework: "react-router" });
  });
});
