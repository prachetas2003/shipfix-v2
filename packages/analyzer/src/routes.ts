import type { RouteCandidate } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { isCodeFile, joinRoot, MAX_SCAN_BYTES } from "./util";

const HTTP_VERBS = ["get", "post", "put", "delete", "patch", "head", "options", "all"] as const;

/** Score a path as a health/readiness probe target (framework-agnostic heuristics). */
export function scoreRoutePath(path: string, method: string): number {
  let score = 0;
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") score += 10;
  const lower = path.toLowerCase();
  for (const kw of ["health", "healthz", "ready", "readyz", "status", "live", "ping"]) {
    if (lower.includes(kw)) score += 30;
  }
  if (path === "/") score += 5;
  score -= path.split("/").filter(Boolean).length;
  return score;
}

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.includes("${") || trimmed.includes("#{")) return null;
  return trimmed.replace(/\/+$/, "") || "/";
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Extract HTTP routes from source text (read-only static patterns). */
export function extractRoutesFromSource(content: string, filePath: string): RouteCandidate[] {
  const found: RouteCandidate[] = [];
  const verbPattern = HTTP_VERBS.join("|");
  const handlerRe = new RegExp(
    `\\.(${verbPattern})\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = handlerRe.exec(content)) !== null) {
    const path = normalizePath(match[2]);
    if (!path) continue;
    const verb = match[1];
    const method = verb.toUpperCase() as RouteCandidate["method"];
    const line = lineOf(content, match.index);
    found.push({
      method,
      path,
      kind: "explicit",
      evidence: [`${filePath}:${line}`],
      score: scoreRoutePath(path, method),
    });
  }

  // Fastify-style: route({ method: 'GET', url: '/health', ... })
  const fastifyRe =
    /route\s*\(\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)['"`][^}]*url\s*:\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = fastifyRe.exec(content)) !== null) {
    const path = normalizePath(match[2]);
    if (!path) continue;
    const method = match[1].toUpperCase() as RouteCandidate["method"];
    const line = lineOf(content, match.index);
    found.push({
      method,
      path,
      kind: "explicit",
      evidence: [`${filePath}:${line}`],
      score: scoreRoutePath(path, method),
    });
  }

  return found;
}

function dedupeRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  const byKey = new Map<string, RouteCandidate>();
  for (const r of routes) {
    const key = `${r.method}:${r.path}`;
    const existing = byKey.get(key);
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      byKey.set(key, r);
    } else if (existing && r.evidence.length) {
      existing.evidence = [...new Set([...existing.evidence, ...r.evidence])];
    }
  }
  return [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Extra route files under a service root worth scanning (shallow). */
function routeFilesUnderRoot(rootDir: string, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!f.startsWith(rootDir === "" ? "" : `${rootDir}/`) && rootDir !== "") continue;
    if (!isCodeFile(f)) continue;
    const base = f.slice(rootDir === "" ? 0 : rootDir.length + 1);
    if (
      base.includes("/routes/") ||
      /(?:^|\/)routes?\.(?:[cm]?[jt]s)x?$/i.test(base) ||
      /(?:^|\/)router\.(?:[cm]?[jt]s)x?$/i.test(base)
    ) {
      out.push(f);
    }
  }
  return out.slice(0, 25);
}

const NEXT_ROUTE_EXT_RE = /\.(?:[cm]?[jt]s)x?$/;

/**
 * Map a Next.js file-based API route file (relative to the service root) to its
 * URL path. Returns null for non-route files and for dynamic segments, which
 * cannot be probed without inventing parameter values.
 */
export function nextApiRoutePath(relFile: string): string | null {
  if (!NEXT_ROUTE_EXT_RE.test(relFile)) return null;
  const noSrc = relFile.startsWith("src/") ? relFile.slice(4) : relFile;

  let segments: string[] | null = null;
  if (noSrc.startsWith("pages/api/")) {
    const rest = noSrc.slice("pages/".length).replace(NEXT_ROUTE_EXT_RE, "");
    segments = rest.split("/");
    if (segments[segments.length - 1] === "index") segments.pop();
  } else if (noSrc.startsWith("app/")) {
    const rest = noSrc.slice("app/".length);
    const parts = rest.split("/");
    const last = parts.pop();
    if (!last || !/^route\.(?:[cm]?[jt]s)x?$/.test(last)) return null;
    // Route groups "(group)" and parallel slots "@slot" don't appear in the URL.
    segments = parts.filter((p) => !(p.startsWith("(") && p.endsWith(")")) && !p.startsWith("@"));
  }
  if (!segments) return null;
  if (segments.some((s) => s.includes("[") || s.includes("]"))) return null;
  return `/${segments.join("/")}` || "/";
}

/**
 * Discover Next.js file-based API route candidates under a service root. These
 * are `inferred` (the handler's HTTP methods are not statically proven), so the
 * planner treats them as probe candidates, not guaranteed GET endpoints.
 */
export function detectNextApiRoutes(
  rootDir: string,
  files: ReadonlySet<string>,
): RouteCandidate[] {
  const routes: RouteCandidate[] = [];
  const prefix = rootDir === "" ? "" : `${rootDir}/`;
  for (const f of files) {
    if (prefix && !f.startsWith(prefix)) continue;
    const rel = f.slice(prefix.length);
    const path = nextApiRoutePath(rel);
    if (!path) continue;
    routes.push({
      method: "GET",
      path,
      kind: "inferred",
      evidence: [f],
      score: scoreRoutePath(path, "GET"),
    });
  }
  return dedupeRoutes(routes);
}

/**
 * Discover HTTP route candidates for a backend service from entrypoints and
 * nearby route modules. Never executes code.
 */
export async function detectRouteCandidates(
  source: RepoSource,
  rootDir: string,
  entrypoints: string[],
  files: ReadonlySet<string>,
): Promise<RouteCandidate[]> {
  const toScan = new Set<string>(entrypoints);
  for (const f of routeFilesUnderRoot(rootDir, files)) toScan.add(f);

  const routes: RouteCandidate[] = [];
  for (const filePath of toScan) {
    const text = await source.readFile(filePath);
    if (!text) continue;
    routes.push(...extractRoutesFromSource(text.slice(0, MAX_SCAN_BYTES), filePath));
  }

  return dedupeRoutes(routes);
}
