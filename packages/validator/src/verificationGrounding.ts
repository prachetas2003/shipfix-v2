import type { DeploymentPlan, PlanService, RepoContext, RouteCandidate } from "@shipfix/contracts";
import type { ValidationIssue } from "./issues";

export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") || "/" : `/${trimmed}`.replace(/\/+$/, "") || "/";
}

export function routeCandidatesForService(ctx: RepoContext, rootDir: string): RouteCandidate[] {
  return ctx.services.find((s) => s.rootDir === rootDir)?.routeCandidates ?? [];
}

/** True when a GET/ALL route candidate matches the normalized path. */
export function pathMatchesCandidate(path: string, candidates: RouteCandidate[]): boolean {
  const normalized = normalizeRoutePath(path);
  return candidates.some(
    (c) => c.path === normalized && (c.method === "GET" || c.method === "HEAD" || c.method === "ALL"),
  );
}

export function topHealthCandidate(candidates: RouteCandidate[]): RouteCandidate | null {
  const getCandidates = candidates.filter(
    (c) => c.method === "GET" || c.method === "HEAD" || c.method === "ALL",
  );
  if (getCandidates.length === 0) return null;
  return [...getCandidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
}

/**
 * Deterministic checks that backend health paths and verification targets are
 * grounded in analyzer route evidence.
 */
export function checkVerificationGrounding(
  plan: DeploymentPlan,
  ctx: RepoContext,
  add: (i: ValidationIssue) => void,
): void {
  for (const svc of plan.services) {
    if (svc.type !== "node_api" && svc.type !== "python_api") continue;

    const candidates = routeCandidatesForService(ctx, svc.rootDir);

    // A backend can only go GREEN with a health path that is grounded in detected
    // routes. Missing/ungrounded health is a YELLOW setup blocker, not silent GREEN.
    const grounded =
      !!svc.healthCheckPath && pathMatchesCandidate(svc.healthCheckPath, candidates);
    if (!grounded) {
      add({
        code: "backend_health_ungrounded",
        severity: "needs_input",
        message: `Backend "${svc.id}" has no health check grounded in detected routes. ShipFix needs a verifiable 2xx health path (e.g. /health) to confirm the API is actually live before deploying.`,
        path: `services.${svc.id}.healthCheckPath`,
      });
    }

    if (svc.healthCheckPath) {
      const normalized = normalizeRoutePath(svc.healthCheckPath);
      if (candidates.length === 0) {
        add({
          code: "health_path_unverified",
          severity: "warning",
          message: `Service "${svc.id}" healthCheckPath "${normalized}" is not backed by route evidence (no routes detected in repo). Verification will treat it as assumed.`,
          path: `services.${svc.id}.healthCheckPath`,
        });
      } else if (!pathMatchesCandidate(normalized, candidates)) {
        add({
          code: "health_path_ungrounded",
          severity: "warning",
          message: `Service "${svc.id}" healthCheckPath "${normalized}" does not match any detected GET route in ${svc.rootDir || "/"}.`,
          path: `services.${svc.id}.healthCheckPath`,
        });
      }
    } else if (candidates.length > 0) {
      const top = topHealthCandidate(candidates);
      add({
        code: "health_path_missing",
        severity: "warning",
        message: `Service "${svc.id}" has route candidates (e.g. ${top?.path ?? "unknown"}) but no healthCheckPath in the plan.`,
        path: `services.${svc.id}.healthCheckPath`,
      });
    }
  }

  for (const [i, check] of plan.verification.entries()) {
    if (check.check !== "health_path" && check.check !== "http_2xx") continue;

    const svc = plan.services.find((s) => s.id === check.serviceId);
    if (!svc) continue;

    const candidates = routeCandidatesForService(ctx, svc.rootDir);
    const explicitPath = check.target ?? svc.healthCheckPath;

    if (!explicitPath) {
      add({
        code: "verification_path_missing",
        severity: "needs_input",
        message: `Verification check "${check.check}" for "${check.serviceId}" has no target path and the service has no healthCheckPath.`,
        path: `verification[${i}]`,
      });
      continue;
    }

    const normalized = normalizeRoutePath(explicitPath);
    if (candidates.length === 0) {
      add({
        code: "verification_path_unverified",
        severity: "warning",
        message: `Verification target "${normalized}" for "${check.serviceId}" is not backed by route evidence. The check will run as assumed.`,
        path: `verification[${i}]`,
      });
    } else if (!pathMatchesCandidate(normalized, candidates)) {
      add({
        code: "verification_path_ungrounded",
        severity: "warning",
        message: `Verification target "${normalized}" for "${check.serviceId}" does not match any detected GET route.`,
        path: `verification[${i}]`,
      });
    }

    if (
      check.target &&
      svc.healthCheckPath &&
      normalizeRoutePath(check.target) !== normalizeRoutePath(svc.healthCheckPath)
    ) {
      add({
        code: "verification_path_mismatch",
        severity: "warning",
        message: `Verification target "${check.target}" differs from service healthCheckPath "${svc.healthCheckPath}" for "${check.serviceId}".`,
        path: `verification[${i}]`,
      });
    }
  }
}

/** Cap confidence when health verification is not fully grounded. */
export function capConfidenceForVerification(
  confidence: number,
  issues: ValidationIssue[],
): number {
  const groundingCodes = new Set([
    "health_path_unverified",
    "health_path_ungrounded",
    "verification_path_unverified",
    "verification_path_ungrounded",
    "verification_path_missing",
  ]);
  let cap = 1;
  if (issues.some((i) => i.code === "verification_path_missing")) cap = Math.min(cap, 0.6);
  if (issues.some((i) => groundingCodes.has(i.code) && i.severity === "warning")) {
    cap = Math.min(cap, 0.85);
  }
  return Math.min(confidence, cap);
}
