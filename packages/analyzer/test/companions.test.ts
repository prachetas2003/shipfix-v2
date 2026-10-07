import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
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

const vitePkg = { name: "web", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "18", "react-dom": "18" }, devDependencies: { vite: "5" } };

async function analyze(files: Record<string, string | object>) {
  return analyzeRepo(repo(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
}

describe("companions", () => {
  it("keeps desktop, mobile, CLI, tooling, scripts and examples out of the deploy set", async () => {
    const ctx = await analyze({
      "package.json": vitePkg,
      "package-lock.json": "{}",
      "src/main.tsx": "const url = import.meta.env.VITE_SUPABASE_URL;",
      "apps/desktop/package.json": { name: "desktop", scripts: { start: "electron ." }, devDependencies: { electron: "30" } },
      "apps/desktop/main.ts": "process.env.DESKTOP_UPDATE_TOKEN",
      "apps/mobile/package.json": { name: "mobile", scripts: { start: "expo start" }, dependencies: { expo: "51", react: "18" } },
      "packages/cli/package.json": { name: "cli", bin: { tool: "index.js" }, scripts: { start: "node index.js" } },
      "mcp/package.json": { name: "mcp", scripts: { start: "node server.js" }, dependencies: { "@modelcontextprotocol/sdk": "1" } },
      ".claude/skills/ui/scripts/requirements.txt": "pillow\n",
      "scripts/requirements.txt": "requests\n",
      "scripts/seed.py": "import os\nos.environ['SEED_TOKEN']",
      "examples/nextjs/package.json": { name: "ex", scripts: { build: "next build" }, dependencies: { next: "15" } },
      "docs/package.json": { name: "docs", scripts: { dev: "vitepress dev" }, devDependencies: { vitepress: "1" } },
    });

    expect(ctx.services.map((s) => `${s.rootDir || "/"}:${s.framework}`)).toEqual(["/:vite"]);
    expect(ctx.companions.map((c) => `${c.rootDir}:${c.kind}`)).toEqual([
      ".claude/skills/ui/scripts:tooling",
      "apps/desktop:desktop",
      "apps/mobile:mobile",
      "docs:docs",
      "examples/nextjs:example",
      "mcp:mcp_server",
      "packages/cli:cli",
      "scripts:scripts",
    ]);
    expect(ctx.envRefs.map((r) => r.name)).toEqual(["VITE_SUPABASE_URL"]);
    expect(synthesizeDeterministicPlan(ctx)?.services.map((s) => s.rootDir)).toEqual([""]);
  });

  it("keeps web apps that also ship a desktop wrapper, and ignores tools on the workspace root", async () => {
    const ctx = await analyze({
      "package.json": { name: "root", private: true, scripts: { deploy: "wrangler deploy" }, devDependencies: { wrangler: "3" } },
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "pnpm-lock.yaml": "",
      "apps/chat/package.json": { name: "chat", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" }, devDependencies: { "@tauri-apps/cli": "2" } },
    });
    expect(ctx.services.map((s) => `${s.rootDir}:${s.framework}`)).toEqual(["apps/chat:next"]);
    expect(ctx.companions).toEqual([]);
  });

  it("recognizes a plain Node HTTP server as a backend", async () => {
    const ctx = await analyze({
      "package.json": vitePkg,
      "package-lock.json": "{}",
      "src/main.tsx": "",
      "server/package.json": { name: "server", scripts: { start: "node index.js" }, dependencies: { ws: "8" } },
      "server/package-lock.json": "{}",
      "server/index.js": "const http = require('http');\nhttp.createServer(handler).listen(process.env.PORT || 3000);",
    });
    const server = ctx.services.find((s) => s.rootDir === "server");
    expect(server).toMatchObject({ framework: "node-http", role: "backend" });
    expect(synthesizeDeterministicPlan(ctx)?.services.map((s) => s.type).sort()).toEqual(["frontend_static", "node_api"]);
  });

  it("names serverless and Python app frameworks instead of 'unknown'", async () => {
    const ctx = await analyze({
      "worker/package.json": { name: "w", scripts: { deploy: "wrangler deploy" }, devDependencies: { wrangler: "3" } },
      "functions/package.json": { name: "f", scripts: { serve: "firebase emulators:start" }, dependencies: { "firebase-functions": "5" } },
      "hono/package.json": { name: "h", scripts: { start: "node dist/index.js" }, dependencies: { hono: "4", "@hono/node-server": "1" } },
      "dash/requirements.txt": "pandas\nstreamlit==1.38\n",
      "api/pyproject.toml": '[project]\ndependencies = ["fastapi", "streamlit"]\n',
    });
    const by = Object.fromEntries(ctx.services.map((s) => [s.rootDir, `${s.framework}/${s.role}`]));
    expect(by).toEqual({
      worker: "cloudflare-worker/worker",
      functions: "firebase-functions/worker",
      hono: "hono/backend",
      dash: "streamlit/backend",
      api: "fastapi/backend",
    });
  });
});

describe("content tooling beside the app", () => {
  it("leaves design mockups, Remotion, Sanity Studio and react-email previews out", async () => {
    const ctx = await analyze({
      "package.json": vitePkg,
      "package-lock.json": "{}",
      "design/app-screens/package.json": vitePkg,
      "remotion/package.json": { name: "video", scripts: { dev: "remotion studio" }, dependencies: { react: "18", "react-dom": "18", remotion: "4", "@remotion/cli": "4" } },
      "studio/package.json": { name: "studio", scripts: { dev: "sanity dev" }, dependencies: { react: "18", "react-dom": "18", sanity: "3" } },
      "studio/sanity.config.ts": "export default {}",
      "packages/emails/package.json": { name: "emails", scripts: { dev: "email dev" }, dependencies: { react: "18", "react-dom": "18", "react-email": "3" } },
    });
    expect(ctx.services.map((s) => s.rootDir)).toEqual([""]);
    expect(ctx.companions.map((c) => c.rootDir).sort()).toEqual(["design/app-screens", "packages/emails", "remotion", "studio"]);
  });

  it("keeps an app that embeds the Remotion player", async () => {
    const ctx = await analyze({
      "web/package.json": { ...vitePkg, dependencies: { ...vitePkg.dependencies, remotion: "4", "@remotion/player": "4" } },
    });
    expect(ctx.services.map((s) => s.rootDir)).toEqual(["web"]);
  });
});

describe("root packages that are not apps", () => {
  const backendPkg = { name: "api", scripts: { start: "node index.js" }, dependencies: { express: "4" } };

  it("treats a root that only hands scripts off to subfolders as an orchestrator", async () => {
    const ctx = await analyze({
      "package.json": {
        scripts: {
          dev: 'concurrently "npm --prefix backend start" "npm --prefix frontend run dev"',
          start: 'concurrently "npm --prefix backend start" "npm --prefix frontend start"',
        },
        devDependencies: { concurrently: "8" },
      },
      "frontend/package.json": vitePkg,
      "frontend/package-lock.json": "{}",
      "backend/package.json": backendPkg,
      "backend/package-lock.json": "{}",
      "backend/index.js": "app.get('/health', h); app.listen(process.env.PORT)",
    });
    expect(ctx.services.map((s) => s.rootDir).sort()).toEqual(["backend", "frontend"]);
    expect(synthesizeDeterministicPlan(ctx)?.services.map((s) => s.type).sort()).toEqual(["frontend_static", "node_api"]);
  });

  it("ignores a stray root package.json with nothing to run", async () => {
    const ctx = await analyze({
      "package.json": { dependencies: { "next-themes": "0.3" } },
      "web/package.json": vitePkg,
      "web/package-lock.json": "{}",
    });
    expect(ctx.services.map((s) => s.rootDir)).toEqual(["web"]);
  });

  it("still treats a root that runs its own code as a service", async () => {
    const ctx = await analyze({
      "package.json": { scripts: { start: "node bot.js", dev: "npm --prefix web run dev" } },
      "bot.js": "console.log(1)",
      "web/package.json": vitePkg,
    });
    expect(ctx.services.map((s) => s.rootDir)).toContain("");
  });
});
