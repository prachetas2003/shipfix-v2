import { describe, expect, it } from "vitest";
import { DeploymentPlan } from "@shipfix/contracts";
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

const viteWeb = {
  "web/package.json": { name: "web", scripts: { build: "vite build" }, dependencies: { react: "19", "react-dom": "19" }, devDependencies: { vite: "7" } },
  "web/package-lock.json": "{}",
  "web/src/main.tsx": "fetch(import.meta.env.VITE_API_URL + '/items');",
};

describe("Python web services", () => {
  it("infers a FastAPI start command and health route, and plans a Render python_api", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "api/requirements.txt": "fastapi==0.110\nuvicorn[standard]\nsqlalchemy\n",
      "api/app/__init__.py": "",
      "api/app/main.py": [
        "import os",
        "from fastapi import FastAPI",
        "app = FastAPI(title='x')",
        "engine = os.environ['DATABASE_URL']",
        "origins = os.getenv('FRONTEND_URL', 'http://localhost:5173')",
        "key = os.getenv('OPENAI_API_KEY')",
        "@app.get('/healthz')",
        "def health(): return {'ok': True}",
      ].join("\n"),
    });
    const api = ctx.services.find((s) => s.rootDir === "api");
    expect(api?.inferredRun).toMatchObject({
      install: "pip install -r requirements.txt",
      start: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    });
    expect(api?.routeCandidates[0]?.path).toBe("/healthz");
    const refs = ctx.envRefs.filter((r) => r.service === "api");
    expect(refs.find((r) => r.name === "DATABASE_URL")?.required).toBe(true);
    expect(refs.find((r) => r.name === "FRONTEND_URL")?.required).toBe(false);
    expect(refs.find((r) => r.name === "OPENAI_API_KEY")?.required).toBe(true);

    const plan = synthesizeDeterministicPlan(ctx);
    const svc = plan?.services.find((s) => s.id === "api");
    expect(svc).toMatchObject({ type: "python_api", provider: "render", start: api?.inferredRun?.start, healthCheckPath: "/healthz" });
    expect(svc?.env.find((e) => e.name === "DATABASE_URL")?.source).toBe("generated_from_managed");
    expect(svc?.env.find((e) => e.name === "OPENAI_API_KEY")?.source).toBe("user_secret");
    expect(plan?.services.find((s) => s.id === "web")?.env.find((e) => e.name === "VITE_API_URL")?.ref).toBe("api.publicUrl");

    const res = validatePlan(plan!, ctx, caps);
    expect(res.issues.filter((i) => i.severity === "fatal")).toEqual([]);
    expect(res.plan.classification).toBe("needs_setup"); // OPENAI_API_KEY must come from the user
  });

  it("adds gunicorn for Flask when it isn't in requirements", async () => {
    const ctx = await analyze({
      "requirements.txt": "flask\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/health')\ndef h(): return 'ok'\n",
    });
    expect(ctx.services[0].inferredRun).toMatchObject({
      install: "pip install -r requirements.txt gunicorn",
      start: 'gunicorn "app:app" --bind 0.0.0.0:$PORT',
    });
    const res = validatePlan(synthesizeDeterministicPlan(ctx)!, ctx, caps);
    expect(res.plan.classification).toBe("deployable");
  });

  it("starts FastAPI app factories", async () => {
    const factory = (tail: string) =>
      analyze({
        "requirements.txt": "fastapi\nuvicorn\n",
        "app/main.py": `from fastapi import FastAPI\n\ndef create_app():\n    app = FastAPI(lifespan=lifespan)\n\n    @app.get("/health")\n    def h(): return {}\n    return app\n${tail}`,
      });
    const bare = await factory("");
    expect(bare.services[0].inferredRun?.start).toBe("uvicorn app.main:create_app --factory --host 0.0.0.0 --port $PORT");
    expect(bare.services[0].routeCandidates[0]?.path).toBe("/health");
    const assigned = await factory("\napplication = create_app()\n");
    expect(assigned.services[0].inferredRun?.start).toBe("uvicorn app.main:application --host 0.0.0.0 --port $PORT");
  });

  it("does not treat an app built under __main__ as a factory", async () => {
    const ctx = await analyze({
      "requirements.txt": "fastapi\n",
      "main.py": "from fastapi import FastAPI\n\ndef helper():\n    return 1\n\nif __name__ == '__main__':\n    app = FastAPI()\n",
    });
    expect(ctx.services[0].inferredRun).toBeUndefined();
  });

  it("prefers the repo's Procfile web process", async () => {
    const ctx = await analyze({
      "requirements.txt": "fastapi\nuvicorn\n",
      Procfile: "web: uvicorn server:api --host 0.0.0.0 --port $PORT --workers 2\n",
      "server.py": "from fastapi import FastAPI\napi = FastAPI()\n",
    });
    expect(ctx.services[0].inferredRun?.start).toBe("uvicorn server:api --host 0.0.0.0 --port $PORT --workers 2");
    // FastAPI always serves its OpenAPI document, so that is the grounded probe.
    expect(synthesizeDeterministicPlan(ctx)?.services[0].healthCheckPath).toBe("/openapi.json");
  });

  it("runs Streamlit on Render's port and probes its UI", async () => {
    const ctx = await analyze({
      "requirements.txt": "streamlit\npandas\n",
      "streamlit_app.py": "import streamlit as st\nst.title('hi')\n",
    });
    expect(ctx.services[0].inferredRun?.start).toBe(
      "streamlit run streamlit_app.py --server.port $PORT --server.address 0.0.0.0 --server.headless true",
    );
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.goal).toContain("Streamlit app on Render");
    expect(validatePlan(plan!, ctx, caps).plan.classification).toBe("deployable");
  });

  it("skips Gradio apps that hardcode their host and port", async () => {
    const ctx = await analyze({
      "requirements.txt": "gradio\n",
      "app.py": "import gradio as gr\ndemo = gr.Interface(fn=f, inputs='text', outputs='text')\ndemo.launch(server_port=7860)\n",
    });
    expect(ctx.services[0].inferredRun).toBeUndefined();
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("falls back to the Dockerfile when the Python start command can't be inferred", async () => {
    const ctx = await analyze({
      "pyproject.toml": "[project]\ndependencies = ['django']\n",
      Dockerfile: "FROM python:3.12\nEXPOSE 8000\nCMD gunicorn site.wsgi\n",
      "manage.py": "",
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services[0]).toMatchObject({ type: "docker_service", install: null, start: null });
    expect(validatePlan(plan!, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("leaves Python projects with no web framework out of slice", async () => {
    const ctx = await analyze({ "requirements.txt": "requests\n", "bot.py": "import requests\n" });
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
    const plan = DeploymentPlan.parse({
      goal: "x",
      classification: "diagnose_only",
      services: [],
      managed: [],
      wiring: [],
      deployOrder: [],
      questions: [],
      blockers: [],
      verification: [],
      confidence: 0.5,
    });
    expect(validatePlan(plan, ctx, caps).issues.map((i) => i.code)).toContain("repo_python_unsupported");
  });

  it("ignores .py scripts inside a Node service when collecting env", async () => {
    const ctx = await analyze({
      "package.json": { name: "api", scripts: { start: "node index.js" }, dependencies: { express: "4" } },
      "package-lock.json": "{}",
      "index.js": "require('express')().get('/health', () => {}).listen(process.env.PORT);",
      "tools/seed.py": "import os\nos.environ['ADMIN_TOKEN']\n",
    });
    expect(ctx.envRefs.map((r) => r.name)).not.toContain("ADMIN_TOKEN");
  });
});

describe("S3-compatible storage the user brings", () => {
  it("plans the app and asks for the bucket credentials the SDK reads", async () => {
    const ctx = await analyze({
      "package.json": { name: "app", scripts: { build: "next build" }, dependencies: { next: "15", react: "19", "react-dom": "19", "@aws-sdk/client-s3": "3" } },
      "package-lock.json": "{}",
      "lib/s3.ts": "import { S3Client } from '@aws-sdk/client-s3';\nexport const s3 = new S3Client({});\nexport const bucket = process.env.S3_BUCKET_NAME;",
    });
    expect(ctx.dataNeeds.map((d) => d.kind)).toContain("object_storage");
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.managed).toEqual([]);
    const env = plan?.services[0].env ?? [];
    expect(env.map((e) => e.name).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET_NAME"]);
    expect(env.every((e) => e.source === "user_secret")).toBe(true);
    expect(plan?.questions[0]?.prompt).toContain("S3-compatible bucket");
    expect(plan?.blockers.map((b) => b.title)).toContain("Uses your own file storage bucket");
    expect(validatePlan(plan!, ctx, caps).plan.classification).toBe("needs_setup");
  });
});

describe("Dockerfile services", () => {
  it("deploys a Dockerfile that declares its port next to a Vite frontend", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "server/Dockerfile": "FROM golang:1.22\nCOPY . .\nRUN go build -o app\nEXPOSE 8080\nCMD ./app\n",
      "server/main.go": "package main",
    });
    const server = ctx.services.find((s) => s.rootDir === "server");
    expect(server).toMatchObject({ language: "docker", role: "backend" });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "api")).toMatchObject({ type: "docker_service", rootDir: "server" });
    expect(plan?.blockers.map((b) => b.title)).toContain("Container health is not verifiable");
    const res = validatePlan(plan!, ctx, caps);
    expect(res.issues.filter((i) => i.severity === "fatal")).toEqual([]);
    expect(res.plan.classification).toBe("deployable");
  });

  it("keeps a Dockerfile with no EXPOSE out of slice", async () => {
    const ctx = await analyze({ Dockerfile: "FROM node:20\nCMD node job.js\n" });
    expect(ctx.services[0].role).toBe("unknown");
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });

  it("attaches a root Dockerfile that copies one backend subfolder to that service", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "server/requirements.txt": "fastapi==0.110\nuvicorn[standard]\n",
      "server/app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return {'ok': True}\n",
      "ai/model.py": "x = 1\n",
      Dockerfile: "FROM python:3.12\nCOPY server /app\nCOPY ai /app/ai\nWORKDIR /app\nEXPOSE 8000\nCMD uvicorn app.main:app --host 0.0.0.0 --port 8000\n",
    });
    expect(ctx.services.map((s) => s.language)).not.toContain("docker");
    const server = ctx.services.find((s) => s.rootDir === "server");
    expect(server).toMatchObject({
      language: "python",
      role: "backend",
      hasDockerfile: true,
      dockerfilePath: "Dockerfile",
      dockerContext: "",
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "api")).toMatchObject({
      type: "docker_service",
      rootDir: "server",
      dockerfilePath: "Dockerfile",
      dockerContext: "",
      install: null,
      start: null,
    });
    const res = validatePlan(plan!, ctx, caps);
    expect(res.issues.filter((i) => i.severity === "fatal")).toEqual([]);
    expect(res.plan.classification).toBe("deployable");
  });

  it("treats a compose file next to that Dockerfile as the local stack", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "docker-compose.yml": "services:\n  api:\n    build: .\n    ports: ['8000:8000']\n",
      "server/requirements.txt": "fastapi\nuvicorn\n",
      "server/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return {'ok': True}\n",
      Dockerfile: "FROM python:3.12\nCOPY server /app\nEXPOSE 8000\nCMD uvicorn main:app --host 0.0.0.0 --port 8000\n",
    });
    expect(ctx.services.some((s) => s.framework === "docker-compose")).toBe(false);
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "api")).toMatchObject({
      type: "docker_service",
      rootDir: "server",
      dockerfilePath: "Dockerfile",
    });
    expect(validatePlan(plan!, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("uses a Dockerfile in a subfolder when its build context is the repo root", async () => {
    const ctx = await analyze({
      "requirements.txt": "fastapi\nuvicorn\n",
      "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return {'ok': True}\n",
      "docker/Dockerfile": "FROM python:3.12\nCOPY requirements.txt .\nCOPY . .\nEXPOSE 8000\nCMD uvicorn app.main:app --host 0.0.0.0 --port 8000\n",
    });
    expect(ctx.services.map((s) => s.language)).toEqual(["python"]);
    expect(ctx.services[0]).toMatchObject({
      rootDir: "",
      dockerfilePath: "docker/Dockerfile",
      dockerContext: "",
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services[0]).toMatchObject({
      type: "docker_service",
      rootDir: "",
      dockerfilePath: "docker/Dockerfile",
      dockerContext: "",
    });
    expect(validatePlan(plan!, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("keeps the frontend when a backend Dockerfile's context is the repo root", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "requirements.txt": "fastapi\nuvicorn\n",
      "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return {'ok': True}\n",
      "backend/Dockerfile": "FROM python:3.12\nCOPY requirements.txt .\nCOPY backend/ backend/\nEXPOSE 8000\nCMD uvicorn backend.main:app\n",
    });
    expect(ctx.services.some((s) => s.language === "docker")).toBe(false);
    expect(ctx.services.find((s) => s.rootDir === "")).toMatchObject({
      dockerfilePath: "backend/Dockerfile",
      dockerContext: "",
    });
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "api")).toMatchObject({ type: "docker_service", rootDir: "" });
    expect(plan?.services.find((s) => s.id === "web")?.type).toBe("frontend_static");
    expect(validatePlan(plan!, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("does not let a port-less Dockerfile take over the backend it copies", async () => {
    const ctx = await analyze({
      "server/requirements.txt": "fastapi\nuvicorn\n",
      "server/app.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return 'ok'\n",
      Dockerfile: "FROM python:3.12\nCOPY server /app\nCMD uvicorn app:app\n",
    });
    const server = ctx.services.find((s) => s.rootDir === "server");
    expect(server?.dockerfilePath).toBeUndefined();
    expect(server?.hasDockerfile).toBe(false);
    expect(ctx.services.some((s) => s.language === "docker" && s.role === "unknown")).toBe(true);
  });

  it("keeps a separate image when the Dockerfile copies more than one service", async () => {
    const ctx = await analyze({
      ...viteWeb,
      "server/requirements.txt": "fastapi\nuvicorn\n",
      "server/app.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      Dockerfile: "FROM python:3.12\nCOPY server /app\nCOPY web /web\nEXPOSE 8000\nCMD uvicorn app:app\n",
    });
    expect(ctx.services.filter((s) => s.role === "backend").map((s) => s.rootDir).sort()).toEqual(["", "server"]);
    expect(synthesizeDeterministicPlan(ctx)).toBeNull();
  });
});
