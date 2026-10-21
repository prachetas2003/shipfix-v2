import type { RouteCandidate, ServiceSignal } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { scoreRoutePath } from "./routes";
import { baseOf, dirOf, isUnder, joinRoot, MAX_SCAN_BYTES } from "./util";

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
  return new RegExp(`(?:^|[\\s'"\\[,])${name}\\b`, "im").test(requirements);
}

/**
 * How to install this service's Python dependencies. requirements.txt stays on
 * pip. A uv lock or a PEP 621 pyproject is exported to a requirements file
 * first, because Render's Python runtime runs pip, not uv, and the start
 * command needs the packages on its PATH. The local project is not installed:
 * these are apps, not libraries.
 */
function pythonInstall(rootDir: string, files: ReadonlySet<string>, manifest: string, extraPackages: string[]): string | null {
  const has = (name: string): boolean => files.has(joinRoot(rootDir, name));
  const extras = extraPackages.length ? ` ${extraPackages.join(" ")}` : "";
  if (has("requirements.txt")) return `pip install -r requirements.txt${extras}`;
  const locked = has("uv.lock");
  const projectDeps = /^\[project\]/m.test(manifest) && /^\s*dependencies\s*=/m.test(manifest);
  if (!locked && !projectDeps) return null;
  const frozen = locked ? " --frozen" : "";
  return `pip install uv && uv export${frozen} --no-dev --no-emit-project -o requirements.txt && pip install -r requirements.txt${extras}`;
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

type Read = (file: string) => Promise<string>;

export interface DjangoProject {
  /** Folder holding manage.py, relative to the service root ("" when it is the root). */
  appDir: string;
  /** Dotted WSGI module, e.g. "mysite.wsgi". */
  wsgiModule: string;
  settingsFiles: string[];
  /** ALLOWED_HOSTS accepts a host set at deploy time (env, "*", or *.onrender.com). */
  hostsConfigurable: boolean;
  usesPostgres: boolean;
  routes: RouteCandidate[];
}

const ALLOWED_HOSTS_RE = /ALLOWED_HOSTS\s*(?:\+?=\s*(\[[^\]]*\]|[^\n]+)|\.(?:append|extend)\(([^\n]+))/g;
const HOSTS_FROM_DEPLOY_RE = /\*|environ|getenv|config\(|\benv(\.\w+)?\(|onrender\.com|RENDER_EXTERNAL_HOSTNAME/;
const DJANGO_POSTGRES_RE = /postgresql|postgis|dj_database_url|\benv\.db(_url)?\(|DATABASE_URL/;

/** A Django project laid out by `startproject`: manage.py naming <pkg>.settings, and <pkg>/wsgi.py. */
export async function detectDjangoProject(files: ReadonlySet<string>, serviceRoot: string, read: Read): Promise<DjangoProject | null> {
  let manage = joinRoot(serviceRoot, "manage.py");
  if (!files.has(manage)) {
    // Replit-style layouts keep the dependency manifest at the root and the
    // Django project in a subfolder (artifacts/<app>/manage.py).
    const nested = [...files].filter((f) => {
      if (!isUnder(f, serviceRoot)) return false;
      const parts = relToRoot(f, serviceRoot).split("/");
      return parts.at(-1) === "manage.py" && parts.length <= 3 && !parts.some((p) => /^(\.?venv|tests?|node_modules)$/.test(p));
    });
    if (nested.length !== 1) return null;
    manage = nested[0]!;
  }
  const rootDir = manage.includes("/") ? manage.slice(0, manage.lastIndexOf("/")) : "";
  const appDir = rootDir === serviceRoot ? "" : relToRoot(rootDir, serviceRoot);
  const settingsModule = /DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)['"]/.exec(await read(manage))?.[1];
  const pkg = settingsModule?.split(".")[0];
  if (!pkg || !files.has(joinRoot(rootDir, `${pkg}/wsgi.py`))) return null;

  const settingsRe = new RegExp(`^${pkg}/settings(\\.py|/[\\w/]+\\.py)$`);
  const settingsFiles = [...files].filter((f) => isUnder(f, rootDir) && settingsRe.test(relToRoot(f, rootDir)));
  const settings = (await Promise.all(settingsFiles.map(read))).join("\n");
  const hostsConfigurable = [...settings.matchAll(ALLOWED_HOSTS_RE)].some((m) => HOSTS_FROM_DEPLOY_RE.test(m[1] ?? m[2] ?? ""));

  const urlconf = /ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/.exec(settings)?.[1] ?? `${pkg}.urls`;
  const urlsFile = joinRoot(rootDir, `${urlconf.replace(/\./g, "/")}.py`);
  const routes: RouteCandidate[] = [];
  if (files.has(urlsFile)) {
    const urls = await read(urlsFile);
    for (const m of urls.matchAll(/\bpath\(\s*['"]([^'"]*)['"]\s*,\s*([^\n]*)/g)) {
      const [, prefix, target] = m;
      if (prefix.includes("<")) continue;
      const evidence = `${urlsFile}:${lineOf(urls, m.index ?? 0)}`;
      if (/admin\.site\.urls/.test(target)) routes.push(defaultRoute(`/${prefix}login/`, `${evidence}: Django admin login page`));
      else if (!/^include\(/.test(target.trim())) {
        const path = `/${prefix}`;
        routes.push({ method: "GET", path, kind: "explicit", evidence: [evidence], score: scoreRoutePath(path, "GET") });
      }
    }
  }
  return {
    appDir,
    wsgiModule: `${pkg}.wsgi`,
    settingsFiles,
    hostsConfigurable,
    usesPostgres: DJANGO_POSTGRES_RE.test(settings),
    routes,
  };
}

/**
 * The migration to run before each start: a Procfile `release:` line, Django's
 * migrate when it talks to Postgres, or Alembic when its env.py takes the
 * database URL from the environment (a hardcoded alembic.ini URL would point
 * at the developer's machine).
 */
async function releaseCommand(
  files: ReadonlySet<string>,
  rootDir: string,
  read: Read,
  requirements: string,
  procfile: string,
  django: DjangoProject | null,
): Promise<{ command: string; evidence: string } | null> {
  const release = /^release:\s*(.+)$/m.exec(procfile)?.[1]?.trim();
  if (release) return { command: release, evidence: `${joinRoot(rootDir, "Procfile")}: release process` };
  if (django?.usesPostgres) {
    const manage = joinRoot(django.appDir, "manage.py");
    return { command: `python ${manage} migrate --noinput`, evidence: `${joinRoot(rootDir, manage)}: Django migrations` };
  }
  const ini = joinRoot(rootDir, "alembic.ini");
  if (!files.has(ini) || !hasRequirement(requirements, "alembic")) return null;
  const location = /^\s*script_location\s*=\s*(?:%\(here\)s\/)?([\w./-]+)/m.exec(await read(ini))?.[1] ?? "alembic";
  const envPy = joinRoot(rootDir, `${location.replace(/\/$/, "")}/env.py`);
  if (!files.has(envPy)) return null;
  if (!/os\.environ|getenv|settings\.|get_settings|config\(|DATABASE_URL/.test(await read(envPy))) return null;
  return { command: "alembic upgrade head", evidence: `${envPy}: Alembic reads the database URL from the environment` };
}

/**
 * Derive how a Python web service is installed and started from code evidence,
 * plus the routes it serves. Never guesses: no requirements.txt or no
 * recognizable entry point, or no installable manifest, means no inferredRun.
 */
export async function inferPythonRun(
  source: RepoSource,
  files: ReadonlySet<string>,
  rootDir: string,
  framework: string,
  requirements: string,
): Promise<PythonRunInference> {
  const read = async (file: string): Promise<string> => ((await source.readFile(file)) ?? "").slice(0, MAX_SCAN_BYTES);

  let start: string | null = null;
  const evidence: string[] = [];
  const extraPackages: string[] = [];
  const routeCandidates: RouteCandidate[] = [];

  const procfilePath = joinRoot(rootDir, "Procfile");
  const procfile = files.has(procfilePath) ? await read(procfilePath) : "";
  if (procfile) {
    const web = /^web:\s*(.+)$/m.exec(procfile)?.[1]?.trim();
    if (web) {
      start = web;
      evidence.push(`${procfilePath}: web process`);
    }
  }

  const pyFiles = candidateFiles(rootDir, files);
  const needServer = (pkg: string): void => {
    if (!hasRequirement(requirements, pkg)) extraPackages.push(pkg);
  };

  const django = framework === "django" ? await detectDjangoProject(files, rootDir, read) : null;
  if (framework === "django") {
    // Django rejects every request whose Host isn't in ALLOWED_HOSTS; a list
    // fixed to localhost can't serve a Render URL, so don't claim it can.
    if (!django?.hostsConfigurable) return { routeCandidates };
    routeCandidates.push(...django.routes);
    if (!start) {
      const chdir = django.appDir ? ` --chdir ${django.appDir}` : "";
      start = `gunicorn${chdir} ${django.wsgiModule}:application --bind 0.0.0.0:$PORT`;
      evidence.push(`${joinRoot(rootDir, joinRoot(django.appDir, "manage.py"))}: Django project ${django.wsgiModule}`);
      needServer("gunicorn");
    }
  } else if (framework === "fastapi" || framework === "flask") {
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

  const install = pythonInstall(rootDir, files, requirements, extraPackages);
  if (!start || !install) return { routeCandidates };
  const release = await releaseCommand(files, rootDir, read, requirements, procfile, django);
  if (release) evidence.push(release.evidence);
  return { inferredRun: { install, start, ...(release ? { release: release.command } : {}), evidence }, routeCandidates };
}

/**
 * The migration tool a container runs at start: in the Dockerfile itself or in
 * a shell script it references (docker-entrypoint.sh and the like).
 */
export async function dockerfileMigrates(
  source: RepoSource,
  files: ReadonlySet<string>,
  dockerfile: string,
): Promise<"django" | "alembic" | null> {
  const content = (await source.readFile(dockerfile)) ?? "";
  const scripts = [...content.matchAll(/([\w./-]+\.sh)\b/g)].map((m) => baseOf(m[1]!));
  const dir = dockerfile.includes("/") ? dockerfile.slice(0, dockerfile.lastIndexOf("/")) : "";
  const texts = [content];
  for (const f of files) {
    if (isUnder(f, dir) && scripts.includes(baseOf(f))) texts.push((await source.readFile(f)) ?? "");
  }
  const run = texts.join("\n");
  if (/manage\.py["']?\s+migrate\b/.test(run)) return "django";
  if (/\balembic\b[^\n]*\bupgrade\b/.test(run)) return "alembic";
  return null;
}

/** True when a Dockerfile declares the port its container listens on. */
export function dockerfileExposes(content: string): string | null {
  return /^\s*EXPOSE\s+(\d+)/im.exec(content)?.[1] ?? null;
}

function resolveInRepo(baseDir: string, rel: string): string | null {
  const combined = baseDir ? `${baseDir}/${rel}` : rel;
  const out: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** Whitespace-split a Docker instruction, keeping quoted arguments together. */
function splitDockerArgs(rest: string): string[] | null {
  const args: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of rest) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) args.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  if (cur) args.push(cur);
  return args;
}

/**
 * Build-context paths a Dockerfile COPY/ADD uses, relative to the Dockerfile's
 * directory. Null when a source can't be resolved (variables, globs, absolute
 * paths) so the caller refuses to guess which service the image builds.
 * `--from` copies and remote ADD URLs are ignored.
 */
export function dockerfileCopySources(content: string): string[] | null {
  const sources: string[] = [];
  for (const raw of content.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m = /^(COPY|ADD)\b(.*)$/i.exec(line);
    if (!m) continue;
    let rest = m[2]!.trim();
    if (/^--from=/i.test(rest) || /^<</.test(rest)) continue;
    while (rest.startsWith("--")) {
      const flag = /^(--\S+)(?:\s+|$)/.exec(rest);
      if (!flag) return null;
      rest = rest.slice(flag[0].length).trim();
    }
    if (!rest) continue;
    let args: string[];
    if (rest.startsWith("[")) {
      try {
        const parsed = JSON.parse(rest) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return null;
        args = parsed as string[];
      } catch {
        return null;
      }
    } else {
      const split = splitDockerArgs(rest);
      if (!split) return null;
      args = split;
    }
    if (args.length < 2) return null;
    for (const src of args.slice(0, -1)) {
      if (/^(https?:|git:)/i.test(src)) continue;
      if (src.includes("$") || src.includes("*") || src.startsWith("/")) return null;
      sources.push(src);
    }
  }
  return sources;
}

function pathExists(files: ReadonlySet<string>, abs: string): boolean {
  if (abs === "" || files.has(abs)) return true;
  const prefix = `${abs}/`;
  for (const file of files) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Directory the image is built from. Defaults to the Dockerfile's folder.
 * A Dockerfile under `docker/` or `backend/` often copies the repo root
 * (`COPY requirements.txt`, `COPY . .`) while being built with `-f` from the
 * parent. Use the nearest directory where every copied path exists.
 */
function dockerfileBuildContext(
  dockerfile: string,
  sources: readonly string[],
  files: ReadonlySet<string>,
): string | null {
  const candidates: string[] = [];
  let dir = dirOf(dockerfile);
  for (;;) {
    candidates.push(dir);
    if (dir === "") break;
    dir = dirOf(dir);
  }
  for (const context of candidates) {
    const ok = sources.every((src) => {
      if (src === "." || src === "./") return true;
      const abs = resolveInRepo(context, src);
      return abs !== null && pathExists(files, abs);
    });
    if (ok) return context;
  }
  return null;
}

function sourceTouchesService(abs: string, root: string, serviceRoots: readonly string[]): boolean {
  if (root === "") {
    return !serviceRoots.some(
      (other) => other !== "" && (abs === other || abs.startsWith(`${other}/`)),
    );
  }
  return abs === root || abs.startsWith(`${root}/`) || root.startsWith(`${abs}/`);
}

/**
 * The single service a Dockerfile builds when its COPY paths belong to one
 * service and the Dockerfile is not that service's own file. Returns null
 * when the image copies nothing, several services, or a path we can't resolve.
 */
export function dockerfileSubdirTarget(
  dockerfile: string,
  content: string,
  serviceRoots: readonly string[],
  files: ReadonlySet<string>,
): { serviceRoot: string; context: string } | null {
  const sources = dockerfileCopySources(content);
  if (!sources || sources.length === 0) return null;
  const context = dockerfileBuildContext(dockerfile, sources, files);
  if (context === null) return null;
  const touched = new Set<string>();
  for (const src of sources) {
    const abs = resolveInRepo(context, src);
    if (abs === null) return null;
    const coversAll = abs === context;
    for (const root of serviceRoots) {
      const inContext = context === "" || root === context || root.startsWith(`${context}/`);
      if (!inContext) continue;
      if (coversAll || sourceTouchesService(abs, root, serviceRoots)) touched.add(root);
    }
  }
  if (touched.size !== 1) return null;
  const serviceRoot = [...touched][0]!;
  // The service's own Dockerfile is handled by the normal docker/python paths.
  if (dirOf(dockerfile) === serviceRoot) return null;
  return { serviceRoot, context };
}
