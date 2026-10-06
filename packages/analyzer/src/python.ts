import type { RouteCandidate, ServiceSignal } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { scoreRoutePath } from "./routes";
import { baseOf, isUnder, joinRoot, MAX_SCAN_BYTES } from "./util";

export interface PythonRunInference {
  inferredRun?: ServiceSignal["inferredRun"];
  routeCandidates: RouteCandidate[];
}

const SKIP_SEGMENTS = new Set([
  "venv",
  ".venv",
  "env",
  "site-packages",
  "node_modules",
  "__pycache__",
  "tests",
  "test",
  "migrations",
  "alembic",
  "scripts",
  "notebooks",
  "examples",
]);
const MAX_DEPTH = 3;
const MAX_FILES = 150;
/** Entry-file names worth checking first, in order. */
const PREFERRED_NAMES = ["main.py", "app.py", "server.py", "api.py", "streamlit_app.py", "Home.py", "wsgi.py", "asgi.py"];

const IDENT_RE = /^[A-Za-z_]\w*$/;
const FASTAPI_RE = /^([ \t]*)(\w+)\s*(?::\s*\w+\s*)?=\s*FastAPI\s*\(([^)]*)\)?/m;
const FLASK_RE = /^(\w+)\s*=\s*Flask\s*\(/m;
const FLASK_FACTORY_RE = /^def\s+create_app\s*\(/m;
const DECORATOR_RE = /@(\w+)\.(get|post|put|delete|patch|head|options|route|api_route)\(\s*["']([^"']+)["']([^)]*)\)/g;

function relToRoot(file: string, rootDir: string): string {
  return rootDir === "" ? file : file.slice(rootDir.length + 1);
}

/** Dotted module path for a file relative to the service root, or null if not importable. */
function moduleOf(file: string, rootDir: string): string | null {
  const parts = relToRoot(file, rootDir).replace(/\.py$/, "").split("/");
  return parts.every((p) => IDENT_RE.test(p)) ? parts.join(".") : null;
}

function candidateFiles(rootDir: string, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".py") || !isUnder(file, rootDir)) continue;
    const segments = relToRoot(file, rootDir).split("/");
    if (segments.length > MAX_DEPTH) continue;
    if (segments.slice(0, -1).some((s) => SKIP_SEGMENTS.has(s) || s.startsWith("."))) continue;
    if (/^test_|_test\.py$|^conftest\.py$|^setup\.py$/.test(baseOf(file))) continue;
    out.push(file);
  }
  const rank = (f: string): number => {
    const idx = PREFERRED_NAMES.indexOf(baseOf(f));
    return relToRoot(f, rootDir).split("/").length * 100 + (idx === -1 ? 50 : idx);
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_FILES);
}

function hasRequirement(requirements: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\b`, "im").test(requirements);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function appRoutes(content: string, file: string, appVar: string): RouteCandidate[] {
  const routes: RouteCandidate[] = [];
  for (const m of content.matchAll(DECORATOR_RE)) {
    if (m[1] !== appVar) continue;
    const path = m[3].trim();
    if (!path.startsWith("/") || path.includes("{") || path.includes("<")) continue;
    let method = m[2].toUpperCase();
    if (method === "ROUTE" || method === "API_ROUTE") {
      const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(m[4])?.[1];
      method = !methods || /["']GET["']/i.test(methods) ? "GET" : "POST";
    }
    const normalized = path.replace(/\/+$/, "") || "/";
    routes.push({
      method: method as RouteCandidate["method"],
      path: normalized,
      kind: "explicit",
      evidence: [`${file}:${lineOf(content, m.index ?? 0)}`],
      score: scoreRoutePath(normalized, method),
    });
  }
  return routes;
}

/**
 * For an app built inside a function: the module-level variable holding its
 * result (`app = create_app()`), else `create_app()` for uvicorn --factory.
 */
function factoryTarget(content: string, appIndex: number): string | null {
  const before = content.slice(0, appIndex);
  const def = [...before.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(/gm)].at(-1);
  if (!def) return null;
  const fn = def[1];
  const body = before.slice((def.index ?? 0) + def[0].length).split("\n").slice(1);
  if (body.some((line) => /^[^\s#)\]}]/.test(line))) return null; // a top-level statement closed the def
  const assigned = new RegExp(`^(\\w+)\\s*=\\s*${fn}\\s*\\(`, "m").exec(content);
  return assigned ? assigned[1] : `${fn}()`;
}

function defaultRoute(path: string, evidence: string): RouteCandidate {
  return { method: "GET", path, kind: "inferred", evidence: [evidence], score: scoreRoutePath(path, "GET") };
}

/**
 * Derive how a Python web service is installed and started from code evidence,
 * plus the routes it serves. Never guesses: no requirements.txt or no
 * recognizable entry point means no inferredRun.
 */
export async function inferPythonRun(
  source: RepoSource,
  files: ReadonlySet<string>,
  rootDir: string,
  framework: string,
  requirements: string,
): Promise<PythonRunInference> {
  const hasRequirements = files.has(joinRoot(rootDir, "requirements.txt"));
  const read = async (file: string): Promise<string> => ((await source.readFile(file)) ?? "").slice(0, MAX_SCAN_BYTES);

  let start: string | null = null;
  const evidence: string[] = [];
  const extraPackages: string[] = [];
  const routeCandidates: RouteCandidate[] = [];

  const procfilePath = joinRoot(rootDir, "Procfile");
  if (files.has(procfilePath)) {
    const web = /^web:\s*(.+)$/m.exec(await read(procfilePath))?.[1]?.trim();
    if (web) {
      start = web;
      evidence.push(`${procfilePath}: web process`);
    }
  }

  const pyFiles = candidateFiles(rootDir, files);
  const needServer = (pkg: string): void => {
    if (!hasRequirement(requirements, pkg)) extraPackages.push(pkg);
  };

  if (framework === "fastapi" || framework === "flask") {
    for (const file of pyFiles) {
      const content = await read(file);
      const mod = moduleOf(file, rootDir);
      if (framework === "fastapi") {
        const m = FASTAPI_RE.exec(content);
        if (!m || !mod) continue;
        const appVar = m[2];
        const target = m[1] ? factoryTarget(content, m.index) : appVar;
        if (!target) continue;
        routeCandidates.push(...appRoutes(content, file, appVar));
        const args = m[3] ?? "";
        if (!/openapi_url\s*=\s*None/.test(args)) {
          routeCandidates.push(defaultRoute("/openapi.json", `${file}: FastAPI serves /openapi.json by default`));
        }
        if (!start) {
          const factory = target.endsWith("()");
          start = `uvicorn ${mod}:${factory ? target.slice(0, -2) : target}${factory ? " --factory" : ""} --host 0.0.0.0 --port $PORT`;
          evidence.push(`${file}:${lineOf(content, m.index)}: ${appVar} = FastAPI()`);
          needServer("uvicorn");
        }
        break;
      }
      const m = FLASK_RE.exec(content);
      const factory = FLASK_FACTORY_RE.exec(content);
      if ((!m && !factory) || !mod) continue;
      if (m) routeCandidates.push(...appRoutes(content, file, m[1]));
      if (!start) {
        const target = m ? `${mod}:${m[1]}` : `${mod}:create_app()`;
        start = `gunicorn "${target}" --bind 0.0.0.0:$PORT`;
        evidence.push(m ? `${file}:${lineOf(content, m.index)}: ${m[1]} = Flask()` : `${file}: create_app()`);
        needServer("gunicorn");
      }
      break;
    }
  } else if (framework === "streamlit" || framework === "gradio" || framework === "chainlit") {
    const importRe = new RegExp(`^\\s*(import|from)\\s+${framework}\\b`, "m");
    for (const file of pyFiles) {
      const content = await read(file);
      if (!importRe.test(content)) continue;
      const rel = relToRoot(file, rootDir);
      if (framework === "gradio") {
        const launch = /\.launch\(([^)]*)\)/.exec(content);
        // Explicit host/port arguments override the env vars Render needs.
        if (!launch || /server_(name|port)\s*=/.test(launch[1])) continue;
      }
      if (framework === "chainlit" && !/@cl\.on_(message|chat_start)/.test(content)) continue;
      routeCandidates.push(defaultRoute("/", `${file}: ${framework} serves its UI at /`));
      if (!start) {
        start =
          framework === "streamlit"
            ? `streamlit run ${rel} --server.port $PORT --server.address 0.0.0.0 --server.headless true`
            : framework === "gradio"
              ? `GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=$PORT python ${rel}`
              : `chainlit run ${rel} --host 0.0.0.0 --port $PORT --headless`;
        evidence.push(`${file}: ${framework} entry file`);
      }
      break;
    }
  }

  if (!start || !hasRequirements) return { routeCandidates };
  const install = ["pip install -r requirements.txt", ...extraPackages].join(" ");
  return { inferredRun: { install, start, evidence }, routeCandidates };
}

/** True when a Dockerfile declares the port its container listens on. */
export function dockerfileExposes(content: string): string | null {
  return /^\s*EXPOSE\s+(\d+)/im.exec(content)?.[1] ?? null;
}
