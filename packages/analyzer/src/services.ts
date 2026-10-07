import type { RepoSource } from "./source";
import type { Companion, CompanionKind, ServiceSignal, ServiceRole } from "@shipfix/contracts";
import { detectPackageManager } from "./packageManager";
import { detectNextApiRoutes, detectRouteCandidates } from "./routes";
import { dockerfileExposes, inferPythonRun } from "./python";
import { procfileWorkers, scriptWorkers } from "./workers";
import {
  allDeps,
  baseOf,
  dirOf,
  joinRoot,
  safeParseJson,
  type PackageJson,
} from "./util";

interface FrameworkVerdict {
  framework: string;
  role: ServiceRole;
}

/** Classify a Node package by its dependencies. Evidence-driven, ordered. */
function classifyFramework(deps: Record<string, string>): FrameworkVerdict {
  const has = (name: string): boolean => name in deps;

  // SSR / fullstack frameworks first (they subsume a frontend).
  if (has("next")) return { framework: "next", role: "fullstack" };
  if (has("nuxt") || has("nuxt3")) return { framework: "nuxt", role: "fullstack" };
  if (has("@remix-run/react") || has("@remix-run/node")) {
    const cloudflare = has("wrangler") || has("@remix-run/cloudflare") || has("@remix-run/cloudflare-pages");
    return { framework: cloudflare ? "remix-cloudflare" : "remix", role: "fullstack" };
  }

  // Serverless platforms: real backends, but not a plain Node server. Checked
  // before the Vite-based SSR frameworks, which then build for Cloudflare.
  if (has("wrangler")) return { framework: "cloudflare-worker", role: "worker" };
  if (has("firebase-functions")) return { framework: "firebase-functions", role: "worker" };

  if (has("@tanstack/react-start") || has("@tanstack/solid-start") || has("@tanstack/start")) {
    // Without Nitro/Vinxi the build emits a plain Node server Vercel can't serve.
    const nitro = has("nitro") || has("nitro-nightly") || has("vinxi") || has("@lovable.dev/vite-tanstack-config");
    return { framework: nitro ? "tanstack-start" : "tanstack-start-node", role: "fullstack" };
  }
  if (has("@react-router/dev")) return { framework: "react-router", role: "fullstack" };
  if (has("@sveltejs/kit")) {
    if (has("@sveltejs/adapter-static")) return { framework: "sveltekit-static", role: "frontend" };
    const vercelReady = has("@sveltejs/adapter-auto") || has("@sveltejs/adapter-vercel");
    return { framework: vercelReady ? "sveltekit" : "sveltekit-node", role: "fullstack" };
  }

  // Backends.
  if (has("@nestjs/core")) return { framework: "nest", role: "backend" };
  if (has("fastify")) return { framework: "fastify", role: "backend" };
  if (has("express")) return { framework: "express", role: "backend" };
  if (has("koa")) return { framework: "koa", role: "backend" };
  if (has("@hapi/hapi") || has("hapi")) return { framework: "hapi", role: "backend" };
  if (has("@hono/node-server")) return { framework: "hono", role: "backend" };
  if (has("h3") && !has("nuxt")) return { framework: "h3", role: "backend" };
  if (has("restify")) return { framework: "restify", role: "backend" };
  if (has("polka")) return { framework: "polka", role: "backend" };

  // Client build tools / SPA frameworks.
  if (has("vite")) return { framework: "vite", role: "frontend" };
  if (has("react-scripts")) return { framework: "cra", role: "frontend" };
  if (has("@angular/core")) return { framework: "angular", role: "frontend" };
  if (has("react") && has("react-dom")) return { framework: "react", role: "frontend" };
  if (has("vue")) return { framework: "vue", role: "frontend" };
  if (has("svelte")) return { framework: "svelte", role: "frontend" };

  return { framework: "node", role: "unknown" };
}

/** Common entrypoint paths (relative to a service root) worth surfacing. */
const COMMON_ENTRYPOINTS = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.tsx",
  "src/main.js",
  "src/server.ts",
  "src/server.js",
  "src/app.ts",
  "src/app.js",
  "server.ts",
  "server.js",
  "index.ts",
  "index.js",
  "app.js",
];

const SCRIPT_FILE_RE = /([\w./-]+\.(?:[cm]?js|tsx?|mjs))/g;
const PYTHON_ENTRYPOINTS = [
  "main.py",
  "app.py",
  "src/main.py",
  "src/app.py",
  "api/main.py",
  "server.py",
];

/** Ordered: a FastAPI app that also lists streamlit is still a FastAPI app. */
const PYTHON_FRAMEWORKS: [string, RegExp][] = [
  ["fastapi", /(^|[\s"',[])fastapi\b/im],
  ["django", /(^|[\s"',[])django\b/im],
  ["flask", /(^|[\s"',[])flask\b/im],
  ["streamlit", /(^|[\s"',[])streamlit\b/im],
  ["gradio", /(^|[\s"',[])gradio\b/im],
  ["chainlit", /(^|[\s"',[])chainlit\b/im],
];

/** Pull file paths a service's start/dev/build scripts point at. */
function entrypointsFromScripts(
  scripts: Record<string, string>,
  rootDir: string,
  files: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const key of ["start", "dev", "serve", "build"]) {
    const cmd = scripts[key];
    if (!cmd) continue;
    for (const match of cmd.matchAll(SCRIPT_FILE_RE)) {
      const candidate = joinRoot(rootDir, match[1]);
      if (files.has(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

/** Is this package.json a workspace MANAGER (not a deployable app) itself? */
function isWorkspaceManager(
  pkg: PackageJson,
  rootDir: string,
  files: ReadonlySet<string>,
): boolean {
  if (pkg.workspaces) return true;
  if (files.has(joinRoot(rootDir, "pnpm-workspace.yaml"))) return true;
  return delegatesToSubpackages(pkg.scripts ?? {});
}

/** `npm --prefix web run dev`, `cd api && npm start`, `concurrently "…" "…"`, `turbo run dev`... */
const DELEGATING_SCRIPT_RE =
  /(--prefix[\s=]\S+|\bcd\s+[\w./-]+\s*&&|\s-C\s+\S+|--filter[\s=]|--workspace[\s=]|\bconcurrently\b|\bnpm-run-all\b|\brun-[ps]\b|\bturbo\b|\blerna\b|\bnx\s)/;

/** A root whose run scripts only hand off to packages in subfolders — an orchestrator, not an app. */
function delegatesToSubpackages(scripts: Record<string, string>): boolean {
  const run = (["start", "dev", "serve", "build"] as const).map((k) => scripts[k]).filter(Boolean);
  return run.length > 0 && run.every((cmd) => DELEGATING_SCRIPT_RE.test(cmd));
}

const RUNNABLE_SCRIPTS = ["start", "dev", "serve"] as const;

/**
 * Builder-generated tooling packages that live beside the real app but are
 * never deployed (e.g. Replit Agent's design canvas).
 */
function isBuilderTooling(pkg: PackageJson, rootDir: string): boolean {
  return baseOf(rootDir) === "mockup-sandbox" || /\/mockup-sandbox$/.test(pkg.name ?? "");
}

/**
 * An internal package (shared schema, API client, db module, or a stray root
 * package.json beside the real app): no recognizable framework, nothing to run.
 */
function isInternalLibrary(pkg: PackageJson, role: ServiceRole): boolean {
  if (role !== "unknown") return false;
  const scripts = pkg.scripts ?? {};
  return !RUNNABLE_SCRIPTS.some((key) => Boolean(scripts[key]));
}

const TOOLING_SEGMENTS = new Set([
  ".claude",
  ".agents",
  ".cursor",
  ".github",
  ".codesandbox",
  ".devcontainer",
  ".vscode",
  ".idea",
  ".windsurf",
  ".bolt",
]);
const EXAMPLE_SEGMENTS = new Set([
  "examples",
  "example",
  "samples",
  "templates",
  "fixtures",
  "__fixtures__",
  "testdata",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "e2e-tests",
  "benchmarks",
  "design",
  "mockups",
  "prototypes",
]);
const DOCS_SEGMENTS = new Set(["docs", "doc", "documentation", "docs-site"]);

/** Non-deploy packages recognizable by where they live. Root is never one. */
function companionKindByPath(rootDir: string): CompanionKind | null {
  if (rootDir === "") return null;
  const segments = rootDir.split("/");
  if (segments.some((s) => TOOLING_SEGMENTS.has(s))) return "tooling";
  if (segments.some((s) => EXAMPLE_SEGMENTS.has(s))) return "example";
  if (segments.some((s) => DOCS_SEGMENTS.has(s))) return "docs";
  if (segments.includes("scripts")) return "scripts";
  return null;
}

/** Node packages that build a client app or tool rather than a web service. */
function companionKindByPackage(
  pkg: PackageJson,
  deps: Record<string, string>,
  rootDir: string,
  role: ServiceRole,
  files: ReadonlySet<string>,
): { kind: CompanionKind; evidence: string } | null {
  const has = (name: string): boolean => name in deps;
  // A Next/Nuxt/Remix app with a desktop wrapper is still a web app.
  if (role === "fullstack") return null;
  if (has("electron") || has("@tauri-apps/api") || has("@tauri-apps/cli") || files.has(joinRoot(rootDir, "src-tauri/tauri.conf.json"))) {
    return { kind: "desktop", evidence: "electron/tauri dependency" };
  }
  if (has("react-native") || has("expo")) return { kind: "mobile", evidence: "react-native/expo dependency" };
  if (has("wxt") || has("plasmo") || has("@crxjs/vite-plugin") || has("webextension-polyfill")) {
    return { kind: "browser_extension", evidence: "browser extension tooling dependency" };
  }
  // Content tooling beside the app: video renders, CMS studios, email template previews.
  if (rootDir !== "" && role !== "backend") {
    if (has("@remotion/cli")) return { kind: "tooling", evidence: "@remotion/cli dependency" };
    if (has("sanity") && ["ts", "js"].some((ext) => files.has(joinRoot(rootDir, `sanity.config.${ext}`)))) {
      return { kind: "tooling", evidence: "Sanity Studio (sanity.config)" };
    }
    if (has("react-email")) return { kind: "tooling", evidence: "react-email preview CLI" };
  }
  if (role !== "unknown") return null;
  if (has("@modelcontextprotocol/sdk")) return { kind: "mcp_server", evidence: "@modelcontextprotocol/sdk dependency" };
  if (pkg.bin) return { kind: "cli", evidence: "package.json bin field" };
  return null;
}

const NODE_SERVER_RE = /\.listen\(\s*[\w.]*(port|PORT)|\bcreateServer\(|\bBun\.serve\(|\bDeno\.serve\(/;

/** A Node package without a known framework whose entrypoint starts an HTTP server. */
async function startsHttpServer(
  source: RepoSource,
  scripts: Record<string, string>,
  entrypoints: string[],
): Promise<string | null> {
  if (!scripts.start) return null;
  for (const ep of entrypoints.slice(0, 6)) {
    const text = await source.readFile(ep);
    if (text && NODE_SERVER_RE.test(text)) return ep;
  }
  return null;
}

/** An internal package skipped as a service, with the services that import it. */
export interface WorkspaceLibrary {
  rootDir: string;
  name: string | null;
  /** rootDirs of services that declare this package as a dependency. */
  dependents: string[];
}

export interface DetectedServices {
  services: ServiceSignal[];
  libraries: WorkspaceLibrary[];
  companions: Companion[];
}

/**
 * Discover deployable service candidates: one per package.json, minus pure
 * workspace managers, internal libraries, and builder tooling. Each carries
 * the evidence that justifies its role.
 */
export async function detectServices(
  source: RepoSource,
  files: ReadonlySet<string>,
): Promise<DetectedServices> {
  const fileList = [...files];
  const pkgPaths = fileList.filter((f) => baseOf(f) === "package.json");

  // Root packageManager field can inform workspace children with no lockfile.
  const rootPkg = safeParseJson<PackageJson>(await source.readFile("package.json"));
  const rootPmField = rootPkg?.packageManager;

  const services: ServiceSignal[] = [];
  const libraries: WorkspaceLibrary[] = [];
  const companions: Companion[] = [];
  const serviceDeps = new Map<string, Record<string, string>>();

  for (const pkgPath of pkgPaths) {
    const rootDir = dirOf(pkgPath);
    const pkg = safeParseJson<PackageJson>(await source.readFile(pkgPath));
    if (!pkg) continue;

    const deps = allDeps(pkg);
    const verdict = classifyFramework(deps);

    // Skip workspace managers that aren't themselves an app.
    if ((verdict.role === "unknown" || verdict.role === "worker") && isWorkspaceManager(pkg, rootDir, files)) {
      continue;
    }
    if (isBuilderTooling(pkg, rootDir)) {
      companions.push({ rootDir, kind: "tooling", evidence: [pkgPath] });
      continue;
    }
    const pathKind = companionKindByPath(rootDir);
    if (pathKind) {
      companions.push({ rootDir, kind: pathKind, evidence: [pkgPath] });
      continue;
    }
    if (isInternalLibrary(pkg, verdict.role)) {
      libraries.push({ rootDir, name: typeof pkg.name === "string" ? pkg.name : null, dependents: [] });
      continue;
    }
    const pkgKind = companionKindByPackage(pkg, deps, rootDir, verdict.role, files);
    if (pkgKind) {
      companions.push({ rootDir, kind: pkgKind.kind, evidence: [`${pkgPath}: ${pkgKind.evidence}`] });
      continue;
    }
    serviceDeps.set(rootDir, deps);

    const scripts = pkg.scripts ?? {};
    const dockerfile = joinRoot(rootDir, "Dockerfile");
    const hasDockerfile = files.has(dockerfile);

    const entrypoints = new Set<string>();
    for (const ep of entrypointsFromScripts(scripts, rootDir, files)) entrypoints.add(ep);
    if (typeof pkg.main === "string") {
      const mainPath = joinRoot(rootDir, pkg.main);
      if (files.has(mainPath)) entrypoints.add(mainPath);
    }
    for (const common of COMMON_ENTRYPOINTS) {
      const p = joinRoot(rootDir, common);
      if (files.has(p)) entrypoints.add(p);
    }

    const evidence = [pkgPath];
    if (verdict.framework !== "node") {
      evidence.push(`${pkgPath}: dependency on "${verdict.framework}"`);
    }
    if (hasDockerfile) evidence.push(dockerfile);

    const entrypointList = [...entrypoints];
    if (verdict.role === "unknown") {
      const serverFile = await startsHttpServer(source, scripts, entrypointList);
      if (serverFile) {
        verdict.framework = "node-http";
        verdict.role = "backend";
        evidence.push(`${serverFile}: starts an HTTP server`);
      }
    }
    const routeCandidates =
      verdict.role === "backend" || verdict.role === "fullstack"
        ? await detectRouteCandidates(source, rootDir, entrypointList, files)
        : [];
    if (verdict.framework === "next") {
      routeCandidates.push(...detectNextApiRoutes(rootDir, files));
    }
    const isServer = verdict.role === "backend" || verdict.role === "fullstack";
    const procWorkers = isServer ? await procfileWorkers(source, files, rootDir) : [];
    const workers = procWorkers.length ? procWorkers : isServer ? scriptWorkers(scripts, pkgPath) : [];

    services.push({
      rootDir,
      language: "node",
      framework: verdict.framework,
      role: verdict.role,
      packageManager: detectPackageManager(files, rootDir, rootPmField),
      scripts,
      entrypoints: entrypointList,
      hasDockerfile,
      routeCandidates,
      workers,
      evidence,
    });
  }

  const pythonRoots = new Set<string>();
  for (const file of fileList) {
    if (baseOf(file) === "requirements.txt" || baseOf(file) === "pyproject.toml") {
      pythonRoots.add(dirOf(file));
    }
  }
  const isClaimed = (rootDir: string): boolean =>
    services.some((s) => s.rootDir === rootDir) || companions.some((c) => c.rootDir === rootDir);

  for (const rootDir of pythonRoots) {
    if (isClaimed(rootDir)) continue;
    const reqPath = joinRoot(rootDir, "requirements.txt");
    const pyprojectPath = joinRoot(rootDir, "pyproject.toml");
    const evidence = [reqPath, pyprojectPath].filter((p) => files.has(p));
    const pathKind = companionKindByPath(rootDir);
    if (pathKind) {
      companions.push({ rootDir, kind: pathKind, evidence });
      continue;
    }
    const req = files.has(reqPath) ? (await source.readFile(reqPath)) ?? "" : "";
    const pyproject = files.has(pyprojectPath) ? (await source.readFile(pyprojectPath)) ?? "" : "";
    const depsText = `${req}\n${pyproject}`;
    const framework = PYTHON_FRAMEWORKS.find(([, re]) => re.test(depsText))?.[0] ?? "python";
    const entrypoints = PYTHON_ENTRYPOINTS.map((p) => joinRoot(rootDir, p)).filter((p) => files.has(p));
    const dockerfile = joinRoot(rootDir, "Dockerfile");
    const hasDockerfile = files.has(dockerfile);
    const { inferredRun, routeCandidates } =
      framework === "python"
        ? { inferredRun: undefined, routeCandidates: [] }
        : await inferPythonRun(source, files, rootDir, framework, depsText);
    if (hasDockerfile) {
      const port = dockerfileExposes((await source.readFile(dockerfile)) ?? "");
      if (port) evidence.push(`${dockerfile}: EXPOSE ${port}`);
    }
    if (inferredRun) evidence.push(...inferredRun.evidence);
    services.push({
      rootDir,
      language: "python",
      framework,
      role: framework === "python" ? "unknown" : "backend",
      packageManager: files.has(pyprojectPath) ? "poetry" : "pip",
      scripts: {},
      entrypoints,
      hasDockerfile,
      routeCandidates: routeCandidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
      ...(inferredRun ? { inferredRun } : {}),
      workers: framework === "python" ? [] : await procfileWorkers(source, files, rootDir),
      evidence,
    });
  }

  for (const file of fileList) {
    if (baseOf(file) !== "Dockerfile" && !/(^|\/)docker-compose\.ya?ml$/i.test(file)) continue;
    const rootDir = baseOf(file) === "Dockerfile" ? dirOf(file) : "";
    if (isClaimed(rootDir)) continue;
    const pathKind = companionKindByPath(rootDir);
    if (pathKind) {
      companions.push({ rootDir, kind: pathKind, evidence: [file] });
      continue;
    }
    const isDockerfile = baseOf(file) === "Dockerfile";
    const port = isDockerfile ? dockerfileExposes((await source.readFile(file)) ?? "") : null;
    services.push({
      rootDir,
      language: "docker",
      framework: isDockerfile ? "docker" : "docker-compose",
      // A declared port is the evidence that the container serves HTTP rather than a batch job.
      role: port ? "backend" : "unknown",
      packageManager: "none",
      scripts: {},
      entrypoints: [file],
      hasDockerfile: isDockerfile || files.has(joinRoot(rootDir, "Dockerfile")),
      routeCandidates: [],
      evidence: port ? [file, `${file}: EXPOSE ${port}`] : [file],
    });
  }

  // Stable ordering: shallowest root first, then alphabetical.
  services.sort((a, b) => {
    const depth = a.rootDir.split("/").length - b.rootDir.split("/").length;
    return depth !== 0 ? depth : a.rootDir.localeCompare(b.rootDir);
  });

  for (const lib of libraries) {
    if (!lib.name) continue;
    for (const [rootDir, deps] of serviceDeps) {
      if (lib.name in deps) lib.dependents.push(rootDir);
    }
    lib.dependents.sort();
  }

  companions.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
  return { services, libraries, companions };
}
