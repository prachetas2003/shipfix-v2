import type { RepoSource } from "./source";
import type { ServiceSignal, ServiceRole } from "@shipfix/contracts";
import { detectPackageManager } from "./packageManager";
import { detectRouteCandidates } from "./routes";
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
    return { framework: "remix", role: "fullstack" };
  }

  // Backends.
  if (has("@nestjs/core")) return { framework: "nest", role: "backend" };
  if (has("fastify")) return { framework: "fastify", role: "backend" };
  if (has("express")) return { framework: "express", role: "backend" };
  if (has("koa")) return { framework: "koa", role: "backend" };
  if (has("@hapi/hapi") || has("hapi")) return { framework: "hapi", role: "backend" };

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
  return false;
}

/**
 * Discover deployable service candidates: one per package.json, minus pure
 * workspace managers. Each carries the evidence that justifies its role.
 */
export async function detectServices(
  source: RepoSource,
  files: ReadonlySet<string>,
): Promise<ServiceSignal[]> {
  const fileList = [...files];
  const pkgPaths = fileList.filter((f) => baseOf(f) === "package.json");

  // Root packageManager field can inform workspace children with no lockfile.
  const rootPkg = safeParseJson<PackageJson>(await source.readFile("package.json"));
  const rootPmField = rootPkg?.packageManager;

  const services: ServiceSignal[] = [];

  for (const pkgPath of pkgPaths) {
    const rootDir = dirOf(pkgPath);
    const pkg = safeParseJson<PackageJson>(await source.readFile(pkgPath));
    if (!pkg) continue;

    const deps = allDeps(pkg);
    const verdict = classifyFramework(deps);

    // Skip workspace managers that aren't themselves an app.
    if (verdict.role === "unknown" && isWorkspaceManager(pkg, rootDir, files)) {
      continue;
    }

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
    const routeCandidates =
      verdict.role === "backend" || verdict.role === "fullstack"
        ? await detectRouteCandidates(source, rootDir, entrypointList, files)
        : [];

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
      evidence,
    });
  }

  const pythonRoots = new Set<string>();
  for (const file of fileList) {
    if (baseOf(file) === "requirements.txt" || baseOf(file) === "pyproject.toml") {
      pythonRoots.add(dirOf(file));
    }
  }
  for (const rootDir of pythonRoots) {
    if (services.some((s) => s.rootDir === rootDir)) continue;
    const reqPath = joinRoot(rootDir, "requirements.txt");
    const pyprojectPath = joinRoot(rootDir, "pyproject.toml");
    const req = files.has(reqPath) ? (await source.readFile(reqPath)) ?? "" : "";
    const pyproject = files.has(pyprojectPath) ? (await source.readFile(pyprojectPath)) ?? "" : "";
    const depsText = `${req}\n${pyproject}`;
    const framework = /fastapi/i.test(depsText)
      ? "fastapi"
      : /django/i.test(depsText)
        ? "django"
        : /flask/i.test(depsText)
          ? "flask"
          : "python";
    const entrypoints = PYTHON_ENTRYPOINTS.map((p) => joinRoot(rootDir, p)).filter((p) => files.has(p));
    const evidence = [reqPath, pyprojectPath].filter((p) => files.has(p));
    services.push({
      rootDir,
      language: "python",
      framework,
      role: framework === "fastapi" || framework === "django" || framework === "flask" ? "backend" : "unknown",
      packageManager: files.has(pyprojectPath) ? "poetry" : "pip",
      scripts: {},
      entrypoints,
      hasDockerfile: files.has(joinRoot(rootDir, "Dockerfile")),
      routeCandidates: [],
      evidence,
    });
  }

  for (const file of fileList) {
    if (baseOf(file) !== "Dockerfile" && !/(^|\/)docker-compose\.ya?ml$/i.test(file)) continue;
    const rootDir = baseOf(file) === "Dockerfile" ? dirOf(file) : "";
    if (services.some((s) => s.rootDir === rootDir)) continue;
    services.push({
      rootDir,
      language: "docker",
      framework: baseOf(file) === "Dockerfile" ? "docker" : "docker-compose",
      role: "unknown",
      packageManager: "none",
      scripts: {},
      entrypoints: [file],
      hasDockerfile: baseOf(file) === "Dockerfile" || files.has(joinRoot(rootDir, "Dockerfile")),
      routeCandidates: [],
      evidence: [file],
    });
  }

  // Stable ordering: shallowest root first, then alphabetical.
  services.sort((a, b) => {
    const depth = a.rootDir.split("/").length - b.rootDir.split("/").length;
    return depth !== 0 ? depth : a.rootDir.localeCompare(b.rootDir);
  });

  return services;
}
