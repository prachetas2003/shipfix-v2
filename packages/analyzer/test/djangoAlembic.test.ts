import { describe, expect, it } from "vitest";
import { DeploymentPlan } from "@shipfix/contracts";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo } from "../src/index";

function repo(files: Record<string, string>) {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (p: string) => files[p] ?? null,
  };
}

async function analyze(files: Record<string, string>) {
  return analyzeRepo(repo(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
}

const caps = capabilities(
  { vercel: ["frontend_static", "frontend_ssr"], render: ["node_api", "python_api", "docker_service", "worker"] },
  ["neon", "upstash"],
);

const MANAGE = [
  "import os, sys",
  "def main():",
  "    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')",
  "    from django.core.management import execute_from_command_line",
  "    execute_from_command_line(sys.argv)",
].join("\n");

const URLS = [
  "from django.contrib import admin",
  "from django.urls import include, path",
  "from . import views",
  "urlpatterns = [",
  "    path('admin/', admin.site.urls),",
  "    path('health/', views.health),",
  "    path('api/', include('api.urls')),",
  "    path('items/<int:pk>/', views.item),",
  "]",
].join("\n");

function djangoRepo(settings: string): Record<string, string> {
  return {
    "requirements.txt": "Django==5.0\ndj-database-url==2.1\npsycopg2-binary==2.9\n",
    "manage.py": MANAGE,
    "mysite/__init__.py": "",
    "mysite/wsgi.py": "from django.core.wsgi import get_wsgi_application\napplication = get_wsgi_application()",
    "mysite/urls.py": URLS,
    "mysite/settings.py": settings,
  };
}

const ENV_SETTINGS = [
  "import os",
  "import dj_database_url",
  "SECRET_KEY = os.environ['DJANGO_SECRET_KEY']",
  "ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', '*').split(',')",
  "ROOT_URLCONF = 'mysite.urls'",
  "DATABASES = {'default': dj_database_url.config(conn_max_age=600)}",
].join("\n");

describe("Django", () => {
  it("plans gunicorn with migrate as a release step on a provisioned Neon database", async () => {
    const ctx = await analyze(djangoRepo(ENV_SETTINGS));
    const svc = ctx.services.find((s) => s.rootDir === "");
    expect(svc?.framework).toBe("django");
    expect(svc?.inferredRun).toMatchObject({
      start: "gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT",
      release: "python manage.py migrate --noinput",
    });
    expect(svc?.inferredRun?.install).toContain("gunicorn");
    expect(svc?.routeCandidates.map((r) => r.path)).toEqual(expect.arrayContaining(["/health/", "/admin/login/"]));
    expect(svc?.routeCandidates.map((r) => r.path)).not.toContain("/api/");
    expect(ctx.envRefs.find((r) => r.name === "DATABASE_URL")?.required).toBe(true);
    expect(ctx.dataNeeds.find((d) => d.kind === "postgres")).toMatchObject({ detectedFrom: "django", migrationTool: "django" });

    const plan = DeploymentPlan.parse(synthesizeDeterministicPlan(ctx));
    const api = plan.services.find((s) => s.type === "python_api");
    expect(api?.start).toBe("python manage.py migrate --noinput && gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT");
    expect(plan.managed.find((m) => m.kind === "postgres")?.migration).toBe("django");
    expect(plan.blockers.map((b) => b.title)).toContain("Runs your database migrations on every start");

    const result = validatePlan(plan, ctx, caps);
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("python_start_ungrounded");
    expect(codes).not.toContain("migration_required");
  });

  it("installs a uv-locked Django app that has no requirements.txt", async () => {
    const nested = Object.fromEntries(
      Object.entries(djangoRepo(ENV_SETTINGS))
        .filter(([f]) => f !== "requirements.txt")
        .map(([f, v]) => [`artifacts/valo-pay/${f}`, v]),
    );
    const ctx = await analyze({
      "pyproject.toml": '[project]\nname = "repl-nix-workspace"\ndependencies = [\n  "django>=5.2",\n  "gunicorn>=23",\n  "dj-database-url>=3",\n]\n',
      "uv.lock": "version = 1\n",
      ...nested,
    });
    const svc = ctx.services.find((s) => s.framework === "django");
    expect(svc?.packageManager).toBe("uv");
    expect(svc?.inferredRun?.install).toBe(
      "pip install uv && uv export --frozen --no-dev --no-emit-project -o requirements.txt && pip install -r requirements.txt",
    );
    expect(svc?.inferredRun?.start).toBe(
      "gunicorn --chdir artifacts/valo-pay mysite.wsgi:application --bind 0.0.0.0:$PORT",
    );
    const plan = synthesizeDeterministicPlan(ctx);
    expect(plan?.services.find((s) => s.id === "api")?.type).toBe("python_api");
    expect(validatePlan(plan!, ctx, caps).issues.filter((i) => i.severity === "fatal")).toEqual([]);
  });

  it("exports an unlocked pyproject with uv before pip install", async () => {
    const ctx = await analyze({
      "pyproject.toml": '[project]\nname = "api"\ndependencies = ["fastapi", "uvicorn"]\n',
      "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef h():\n  return {'ok': True}\n",
    });
    expect(ctx.services[0]?.packageManager).toBe("uv");
    expect(ctx.services[0]?.inferredRun?.install).toBe(
      "pip install uv && uv export --no-dev --no-emit-project -o requirements.txt && pip install -r requirements.txt",
    );
    expect(synthesizeDeterministicPlan(ctx)?.services[0]?.type).toBe("python_api");
  });

  it("finds a Django project nested below the root requirements (Replit layout)", async () => {
    const nested = Object.fromEntries(
      Object.entries(djangoRepo(ENV_SETTINGS))
        .filter(([f]) => f !== "requirements.txt")
        .map(([f, v]) => [`artifacts/shop/${f}`, v]),
    );
    const ctx = await analyze({ "requirements.txt": "django>=5.2\ndj-database-url>=3\npsycopg[binary]>=3\n", ...nested });
    const svc = ctx.services.find((s) => s.framework === "django");
    expect(svc?.inferredRun).toMatchObject({
      start: "gunicorn --chdir artifacts/shop mysite.wsgi:application --bind 0.0.0.0:$PORT",
      release: "python artifacts/shop/manage.py migrate --noinput",
    });
    expect(ctx.dataNeeds.find((d) => d.kind === "postgres")).toMatchObject({ migrationTool: "django" });
  });

  it("gives no start command when ALLOWED_HOSTS is hardcoded", async () => {
    const ctx = await analyze(djangoRepo(ENV_SETTINGS.replace(/ALLOWED_HOSTS = .*/, "ALLOWED_HOSTS = ['localhost']")));
    expect(ctx.services.find((s) => s.rootDir === "")?.inferredRun).toBeUndefined();
  });

  it("flags migration_required when the start command drops the release step", async () => {
    const ctx = await analyze(djangoRepo(ENV_SETTINGS));
    const plan = DeploymentPlan.parse(synthesizeDeterministicPlan(ctx));
    const api = plan.services.find((s) => s.type === "python_api")!;
    api.start = "gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT";
    const codes = validatePlan(plan, ctx, caps).issues.map((i) => i.code);
    expect(codes).toContain("migration_required");
    expect(codes).not.toContain("python_start_ungrounded");
  });

  it("reads python-decouple and django-environ settings", async () => {
    const decouple = await analyze(
      djangoRepo(
        [
          "from decouple import config",
          "SECRET_KEY = config('SECRET_KEY')",
          "DEBUG = config('DEBUG', default=False, cast=bool)",
          "ALLOWED_HOSTS = config('ALLOWED_HOSTS', default='*').split(',')",
          "ROOT_URLCONF = 'mysite.urls'",
          "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': config('DB_NAME')}}",
        ].join("\n"),
      ),
    );
    const names = decouple.envRefs.map((r) => [r.name, r.required]);
    expect(names).toEqual(expect.arrayContaining([["SECRET_KEY", true], ["DEBUG", false], ["DB_NAME", true]]));

    const environ = await analyze(
      djangoRepo(
        [
          "import environ",
          "env = environ.Env(DEBUG=(bool, False))",
          "SECRET_KEY = env('SECRET_KEY')",
          "DEBUG = env.bool('DEBUG')",
          "ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['*'])",
          "ROOT_URLCONF = 'mysite.urls'",
          "DATABASES = {'default': env.db()}",
        ].join("\n"),
      ),
    );
    const envNames = environ.envRefs.map((r) => r.name);
    expect(envNames).toEqual(expect.arrayContaining(["SECRET_KEY", "DATABASE_URL"]));
  });

  it("treats a sqlite-only Django project as local storage", async () => {
    const ctx = await analyze(
      djangoRepo(
        [
          "ALLOWED_HOSTS = ['*']",
          "ROOT_URLCONF = 'mysite.urls'",
          "DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': 'db.sqlite3'}}",
        ].join("\n"),
      ),
    );
    expect(ctx.dataNeeds.map((d) => d.kind)).toContain("sqlite_local");
    expect(ctx.services[0]?.inferredRun?.release).toBeUndefined();
  });
});

describe("Alembic", () => {
  it("runs alembic upgrade head before a FastAPI app", async () => {
    const ctx = await analyze({
      "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\nalembic\npsycopg2-binary\n",
      "alembic.ini": "[alembic]\nscript_location = alembic\n",
      "alembic/env.py": "import os\nconfig.set_main_option('sqlalchemy.url', os.environ['DATABASE_URL'])\n",
      "main.py": "import os\nfrom fastapi import FastAPI\napp = FastAPI()\nDB = os.environ['DATABASE_URL']\n@app.get('/health')\ndef h(): return {}\n",
    });
    const svc = ctx.services[0];
    expect(svc?.inferredRun?.release).toBe("alembic upgrade head");
    expect(ctx.dataNeeds.find((d) => d.kind === "postgres")).toMatchObject({ migrationTool: "alembic" });

    const plan = DeploymentPlan.parse(synthesizeDeterministicPlan(ctx));
    expect(plan.services.find((s) => s.type === "python_api")?.start).toBe(
      "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port $PORT",
    );
    expect(plan.managed.find((m) => m.kind === "postgres")?.migration).toBe("alembic");
    const codes = validatePlan(plan, ctx, caps).issues.map((i) => i.code);
    expect(codes).not.toContain("migration_required");
    expect(codes).not.toContain("python_start_ungrounded");
  });

  it("accepts a Docker image whose entrypoint script runs alembic", async () => {
    const ctx = await analyze({
      "api/pyproject.toml": '[project]\nname = "api"\ndependencies = [\n  "fastapi",\n  "alembic>=1.18",\n  "psycopg[binary]>=3",\n]\n',
      "api/alembic.ini": "[alembic]\nscript_location = migrations\n",
      "api/migrations/env.py": "config.set_main_option('sqlalchemy.url', get_settings().database_url)\n",
      "api/docker-entrypoint.sh": "#!/bin/sh\nalembic -c /app/alembic.ini upgrade head\nexec \"$@\"\n",
      "api/Dockerfile": 'FROM python:3.12\nCOPY . /app\nENTRYPOINT ["/app/docker-entrypoint.sh"]\nEXPOSE 8000\nCMD ["uvicorn", "app:app"]\n',
      "api/app.py": "import os\nfrom fastapi import FastAPI\napp = FastAPI()\nDB = os.environ['DATABASE_URL']\n@app.get('/health')\ndef h(): return {}\n",
    });
    expect(ctx.services.find((s) => s.rootDir === "api")?.imageMigrates).toBe("alembic");
    const plan = DeploymentPlan.parse(synthesizeDeterministicPlan(ctx));
    const api = plan.services.find((s) => s.rootDir === "api");
    expect(api?.type).toBe("python_api");
    expect(api?.start).toContain("alembic upgrade head");
    expect(api?.install).toContain("uv export --no-dev");
    expect(plan.managed.find((m) => m.kind === "postgres")?.migration).toBe("alembic");
    expect(validatePlan(plan, ctx, caps).issues.map((i) => i.code)).not.toContain("migration_required");
  });

  it("does not run alembic when env.py has a hardcoded URL", async () => {
    const ctx = await analyze({
      "requirements.txt": "fastapi\nuvicorn\nalembic\npsycopg2-binary\n",
      "alembic.ini": "[alembic]\nsqlalchemy.url = postgresql://localhost/dev\n",
      "alembic/env.py": "from alembic import context\n",
      "main.py": "import os\nfrom fastapi import FastAPI\napp = FastAPI()\nDB = os.environ['DATABASE_URL']\n",
    });
    expect(ctx.services[0]?.inferredRun?.release).toBeUndefined();
  });
});
