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

const caps = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api", "python_api", "docker_service", "worker"] },
  ["neon", "upstash"],
);

const expressWithWorker = (workerScript: string) => ({
  "package.json": {
    name: "api",
    scripts: { start: "node index.js", worker: workerScript },
    dependencies: { express: "4", bullmq: "5", pg: "8" },
  },
  "package-lock.json": "{}",
  "index.js": [
    "const app = require('express')();",
    "const pool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });",
    "app.get('/health', (_, res) => res.send('ok'));",
    "app.listen(process.env.PORT);",
  ].join("\n"),
  "worker.js": "const { Worker } = require('bullmq');\nnew Worker('jobs', async () => {}, { connection: { url: process.env.REDIS_URL } });",
});

describe("background workers", () => {
  it("plans a Render worker that shares the API's database and Redis wiring", async () => {
    const ctx = await analyze(expressWithWorker("node worker.js"));
    expect(ctx.services[0].workers).toEqual([{ name: "worker", script: "worker", evidence: ['package.json: "worker" script'] }]);

    const plan = synthesizeDeterministicPlan(ctx)!;
    const worker = plan.services.find((s) => s.id === "worker");
    expect(worker).toMatchObject({ type: "worker", provider: "render", runtime: "node", start: "npm run worker", healthCheckPath: null });
    const api = plan.services.find((s) => s.id === "api")!;
    expect(worker?.env.map((e) => e.name).sort()).toEqual(api.env.map((e) => e.name).sort());
    expect(plan.wiring.filter((w) => w.toServiceId === "worker").map((w) => w.toEnvName).sort()).toEqual(
      plan.wiring.filter((w) => w.toServiceId === "api").map((w) => w.toEnvName).sort(),
    );
    expect(plan.deployOrder.indexOf("worker")).toBeGreaterThan(plan.deployOrder.indexOf("api"));
    expect(plan.blockers.map((b) => b.title)).toContain("Background worker runs on a paid Render plan");

    const res = validatePlan(plan, ctx, caps);
    expect(res.issues.filter((i) => i.severity === "fatal")).toEqual([]);
    expect(res.plan.classification).toBe("deployable");
  });

  it("does not treat a Cloudflare Worker dev script as a process", async () => {
    const ctx = await analyze(expressWithWorker("wrangler dev"));
    expect(ctx.services[0].workers).toEqual([]);
  });

  it("runs Procfile worker lines verbatim for a Python service", async () => {
    const ctx = await analyze({
      "requirements.txt": "flask\ncelery\nredis\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n@app.route('/health')\ndef h(): return 'ok'\n",
      "tasks.py": "from celery import Celery\ncelery = Celery('tasks')\n",
      Procfile: "web: gunicorn app:app\nworker: celery -A tasks worker --loglevel=info\nrelease: flask db upgrade\n",
    });
    expect(ctx.services[0].workers?.map((w) => w.command)).toEqual(["celery -A tasks worker --loglevel=info"]);
    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.services.find((s) => s.id === "worker")).toMatchObject({
      runtime: "python",
      install: plan.services.find((s) => s.id === "api")?.install,
      start: "celery -A tasks worker --loglevel=info",
    });
    expect(validatePlan(plan, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("flags a worker whose start command the repo does not define", async () => {
    const ctx = await analyze(expressWithWorker("node worker.js"));
    const plan = synthesizeDeterministicPlan(ctx)!;
    const worker = plan.services.find((s) => s.id === "worker")!;
    worker.start = "node other.js";
    const res = validatePlan(plan, ctx, caps);
    expect(res.issues.map((i) => i.code)).toContain("worker_start_ungrounded");
    expect(res.plan.classification).not.toBe("deployable");
  });
});
