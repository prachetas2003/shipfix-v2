import type { DeploymentPlan, VerificationCheck } from "@shipfix/contracts";
import { markAssumedIfNeeded, resolveHealthPath } from "./healthPath.js";

export interface HttpVerifyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpVerifyResult {
  ok: boolean;
  statusCode: number | null;
  url: string;
  check: string;
  detail: string;
  assumedPath?: boolean;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Live HTTP check: require 2xx on base URL + path. */
export async function verifyHttpHealth(
  baseUrl: string,
  path: string,
  opts: HttpVerifyOptions = {},
  meta?: { assumedPath?: boolean },
): Promise<HttpVerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = joinUrl(baseUrl, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const assumedSuffix = meta?.assumedPath ? " (assumed path)" : "";
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      statusCode: res.status,
      url,
      check: "http_2xx",
      detail: ok
        ? `HTTP ${res.status}${assumedSuffix}`
        : `Expected 2xx, got HTTP ${res.status}${assumedSuffix}`,
      assumedPath: meta?.assumedPath,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: null,
      url,
      check: "http_2xx",
      detail: `${e instanceof Error ? e.message : String(e)}${assumedSuffix}`,
      assumedPath: meta?.assumedPath,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeployedResource {
  serviceId: string;
  publicUrl: string;
}

export interface BackendResource {
  serviceId: string;
  publicUrl: string;
}

export { resolveHealthPath, markAssumedIfNeeded, type HealthPathResolution } from "./healthPath.js";

export interface BackendVerifyOutcome {
  serviceId: string;
  results: HttpVerifyResult[];
  ok: boolean;
}

/** Verify each deployed backend using plan verification checks. */
export async function verifyBackends(
  plan: DeploymentPlan,
  backends: BackendResource[],
  opts: HttpVerifyOptions = {},
): Promise<BackendVerifyOutcome[]> {
  const outcomes: BackendVerifyOutcome[] = [];
  for (const b of backends) {
    const svc = plan.services.find((s: { id: string }) => s.id === b.serviceId);
    const resolved = resolveHealthPath(plan, b.serviceId, svc?.healthCheckPath ?? null);
    if (!resolved.path) {
      outcomes.push({
        serviceId: b.serviceId,
        results: [
          {
            ok: false,
            statusCode: null,
            url: b.publicUrl,
            check: "http_2xx",
            detail: resolved.detail,
          },
        ],
        ok: false,
      });
      continue;
    }
    const primary = await verifyHttpHealth(b.publicUrl, resolved.path, opts, {
      assumedPath: resolved.assumed,
    });
    outcomes.push({ serviceId: b.serviceId, results: [primary], ok: primary.ok });
  }
  return outcomes;
}

/** Verify a static frontend loads (HTTP 2xx, HTML content-type when present). */
export async function verifyFrontendLoads(
  publicUrl: string,
  opts: HttpVerifyOptions = {},
): Promise<HttpVerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = publicUrl.replace(/\/+$/, "") + "/";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    const ok = res.status >= 200 && res.status < 300;
    const ct = res.headers.get("content-type") ?? "";
    const html = !ct || ct.includes("text/html");
    const pass = ok && html;
    return {
      ok: pass,
      statusCode: res.status,
      url,
      check: "frontend_loads",
      detail: pass
        ? `HTTP ${res.status}`
        : ok
          ? `Expected HTML, got content-type: ${ct || "(none)"}`
          : `Expected 2xx, got HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: null,
      url,
      check: "frontend_loads",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** CORS evidence: request backend from frontend origin; check Allow-Origin header. */
export async function verifyCorsFrom(
  backendUrl: string,
  healthPath: string,
  frontendOrigin: string,
  opts: HttpVerifyOptions = {},
  meta?: { assumedPath?: boolean },
): Promise<HttpVerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = joinUrl(backendUrl, healthPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const assumedSuffix = meta?.assumedPath ? " (assumed path)" : "";
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Origin: frontendOrigin },
      signal: controller.signal,
    });
    const allow = res.headers.get("access-control-allow-origin");
    const ok =
      res.status >= 200 &&
      res.status < 300 &&
      (allow === "*" || allow === frontendOrigin);
    return {
      ok,
      statusCode: res.status,
      url,
      check: "cors_from",
      detail: ok
        ? `CORS allows ${frontendOrigin}${assumedSuffix}`
        : allow
          ? `Allow-Origin "${allow}" does not match "${frontendOrigin}"${assumedSuffix}`
          : `Missing Access-Control-Allow-Origin header${assumedSuffix}`,
      assumedPath: meta?.assumedPath,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: null,
      url,
      check: "cors_from",
      detail: `${e instanceof Error ? e.message : String(e)}${assumedSuffix}`,
      assumedPath: meta?.assumedPath,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface PlanVerifyOutcome {
  serviceId: string;
  check: string;
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  assumedPath?: boolean;
  /** Set when the planned path failed but a grounded fallback candidate passed. */
  substitutedPath?: string;
  results: HttpVerifyResult[];
}

/** Bound fallback probing so a dead backend doesn't stall verification. */
const MAX_HEALTH_FALLBACKS = 3;

const normPath = (p: string): string => {
  const t = p.trim();
  const lead = t.startsWith("/") ? t : `/${t}`;
  return lead.replace(/\/+$/, "") || "/";
};

/**
 * Probe the planned health path; on a non-2xx, try the remaining grounded
 * candidates (analyzer route evidence carried on the plan) once each. Never
 * invents paths and never fakes success — every probe is recorded.
 */
async function probeHealthWithFallback(
  baseUrl: string,
  primaryPath: string,
  candidates: string[],
  opts: HttpVerifyOptions,
  meta: { assumedPath?: boolean },
): Promise<{ ok: boolean; results: HttpVerifyResult[]; substitutedPath?: string }> {
  const primary = await verifyHttpHealth(baseUrl, primaryPath, opts, meta);
  const results = [primary];
  if (primary.ok) return { ok: true, results };

  const fallbacks = [...new Set(candidates.map(normPath))]
    .filter((p) => p !== normPath(primaryPath))
    .slice(0, MAX_HEALTH_FALLBACKS);

  for (const path of fallbacks) {
    const probe = await verifyHttpHealth(baseUrl, path, opts, {});
    results.push(probe);
    if (probe.ok) {
      probe.detail = `Planned path ${normPath(primaryPath)} failed (${primary.detail}); grounded fallback ${path} responded ${probe.detail}`;
      return { ok: true, results, substitutedPath: path };
    }
  }
  return { ok: false, results };
}

function pathIsUnverified(plan: DeploymentPlan, serviceId: string, path: string | null): boolean {
  if (!path) return false;
  const normalized = path.replace(/\/+$/, "") || "/";
  return plan.blockers.some((b) => {
    const codes = [
      "health_path_unverified",
      "verification_path_unverified",
      "health_path_ungrounded",
      "verification_path_ungrounded",
    ];
    return (
      b.explanation.includes(serviceId) &&
      (b.explanation.includes(normalized) ||
        b.title.toLowerCase().includes("not verified") ||
        b.title.toLowerCase().includes("not found"))
    );
  });
}

/**
 * Execute every check in plan.verification against deployed resources.
 * Skips checks when required URLs are missing; never fakes success.
 */
export async function verifyFromPlan(
  plan: DeploymentPlan,
  resources: DeployedResource[],
  opts: HttpVerifyOptions = {},
): Promise<PlanVerifyOutcome[]> {
  const byId = new Map(resources.map((r) => [r.serviceId, r.publicUrl]));
  const outcomes: PlanVerifyOutcome[] = [];
  // When a health probe passes on a fallback path, later checks (CORS) reuse it.
  const effectiveHealthPath = new Map<string, string>();

  for (const check of plan.verification) {
    if (check.check === "db_connect") {
      outcomes.push({
        serviceId: check.serviceId,
        check: check.check,
        ok: false,
        skipped: true,
        skipReason: "db_connect not implemented in this build",
        results: [],
      });
      continue;
    }

    if (check.check === "frontend_loads") {
      const url = byId.get(check.serviceId);
      if (!url) {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: "service not deployed",
          results: [],
        });
        continue;
      }
      const result = await verifyFrontendLoads(url, opts);
      outcomes.push({
        serviceId: check.serviceId,
        check: check.check,
        ok: result.ok,
        results: [result],
      });
      continue;
    }

    if (check.check === "cors_from") {
      const backendUrl = byId.get(check.serviceId);
      const frontendId = check.target;
      const frontendUrl = frontendId ? byId.get(frontendId) : undefined;
      if (!backendUrl || !frontendUrl) {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: "backend or frontend not deployed",
          results: [],
        });
        continue;
      }
      let frontendOrigin: string;
      try {
        frontendOrigin = new URL(frontendUrl).origin;
      } catch {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: "invalid frontend URL",
          results: [],
        });
        continue;
      }
      const svc = plan.services.find((s) => s.id === check.serviceId);
      let resolved = resolveHealthPath(plan, check.serviceId, svc?.healthCheckPath ?? null);
      const corsPath = effectiveHealthPath.get(check.serviceId) ?? resolved.path;
      if (!corsPath) {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: resolved.detail,
          results: [],
        });
        continue;
      }
      resolved = markAssumedIfNeeded(resolved, pathIsUnverified(plan, check.serviceId, corsPath));
      const result = await verifyCorsFrom(backendUrl, corsPath, frontendOrigin, opts, {
        assumedPath: resolved.assumed,
      });
      outcomes.push({
        serviceId: check.serviceId,
        check: check.check,
        ok: result.ok,
        assumedPath: resolved.assumed,
        results: [result],
      });
      continue;
    }

    if (check.check === "health_path" || check.check === "http_2xx") {
      const url = byId.get(check.serviceId);
      if (!url) {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: "service not deployed",
          results: [],
        });
        continue;
      }
      const svc = plan.services.find((s) => s.id === check.serviceId);
      let resolved = resolveHealthPath(plan, check.serviceId, svc?.healthCheckPath ?? null, check);
      const healthPath = resolved.path;
      if (!healthPath) {
        outcomes.push({
          serviceId: check.serviceId,
          check: check.check,
          ok: false,
          skipped: true,
          skipReason: resolved.detail,
          results: [],
        });
        continue;
      }
      resolved = markAssumedIfNeeded(resolved, pathIsUnverified(plan, check.serviceId, healthPath));
      const probe = await probeHealthWithFallback(
        url,
        healthPath,
        svc?.healthCandidates ?? [],
        opts,
        { assumedPath: resolved.assumed },
      );
      if (probe.ok) {
        effectiveHealthPath.set(check.serviceId, probe.substitutedPath ?? healthPath);
      }
      outcomes.push({
        serviceId: check.serviceId,
        check: check.check,
        ok: probe.ok,
        assumedPath: resolved.assumed,
        substitutedPath: probe.substitutedPath,
        results: probe.results.map((r) => ({ ...r, check: check.check })),
      });
      continue;
    }

    outcomes.push({
      serviceId: check.serviceId,
      check: check.check,
      ok: false,
      skipped: true,
      skipReason: `unknown check: ${check.check}`,
      results: [],
    });
  }

  return outcomes;
}

export type { VerificationCheck };
