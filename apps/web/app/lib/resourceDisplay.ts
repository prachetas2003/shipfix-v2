/**
 * Resource-type-aware display models for ShipFix UI.
 *
 * Mental model: the frontend is the user-facing app; backend and database are
 * supporting infrastructure. Only absolute http(s) URLs may be used as browser
 * links. Bare hostnames must never become hrefs because they resolve as relative
 * paths like /apps/ep-winter-breeze...
 */

import type {
  LayerState,
  RunLayers,
  SnapshotResource,
  VerificationEntry,
} from "./api";

/** Returns an href only for absolute http(s) URLs; never for bare hostnames. */
export function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export interface FrontendDisplay {
  state: LayerState;
  openAppUrl: string | null;
  provider: string | null;
}

export interface BackendDisplay {
  state: LayerState;
  /** Render service URL; metadata. Opening "/" may 404 on API-only backends. */
  baseUrl: string | null;
  healthCheckUrl: string | null;
  healthCheckPassed: boolean;
  provider: string | null;
}

export interface DatabaseDisplay {
  state: LayerState;
  /** Neon host; display metadata only, not a browser link. */
  host: string | null;
  provider: string | null;
  exposesEnv: string | null;
}

export interface AppResourceDisplay {
  frontend: FrontendDisplay | null;
  backend: BackendDisplay | null;
  database: DatabaseDisplay | null;
  fullStack: RunLayers["fullStack"];
}

function layerState(
  layer: { state: LayerState } | null | undefined,
  fallback: LayerState = "not_attempted",
): LayerState {
  return layer?.state ?? fallback;
}

function backendHealthCheck(
  verification: VerificationEntry[],
  backendServiceId: string | undefined,
  backendBaseUrl: string | null,
  plannedHealthPath: string | null | undefined,
): VerificationEntry | undefined {
  if (!backendServiceId) return undefined;
  for (let i = verification.length - 1; i >= 0; i--) {
    const v = verification[i];
    if (
      v.serviceId === backendServiceId &&
      (v.check === "health_path" || v.check === "http_2xx") &&
      !v.skipped &&
      v.ok
    ) {
      if (v.url) return v;
      if (backendBaseUrl && plannedHealthPath) {
        const base = backendBaseUrl.replace(/\/+$/, "");
        const path = plannedHealthPath.startsWith("/") ? plannedHealthPath : `/${plannedHealthPath}`;
        return { ...v, url: `${base}${path}` };
      }
      return v;
    }
  }
  return undefined;
}

/**
 * Build display models from snapshot resources, layers, and verification.
 * Uses verification URLs for backend health, not the bare service root.
 */
export function buildAppResourceDisplay(input: {
  resources: SnapshotResource[];
  layers: RunLayers | null;
  verification?: VerificationEntry[];
  plan?: { services?: Array<{ id: string; type: string; healthCheckPath?: string | null }> } | null;
}): AppResourceDisplay | null {
  if (!input.layers) return null;

  const { resources, layers, verification = [], plan } = input;
  const frontendRes = resources.find((r) => r.role === "frontend");
  const backendRes = resources.find((r) => r.role === "backend");
  const dbRes = resources.find((r) => r.role === "database");
  const backendPlan = plan?.services?.find((s) => s.type === "node_api" || s.id === backendRes?.serviceId);

  const health = backendHealthCheck(
    verification,
    backendRes?.serviceId,
    safeExternalHref(layers.backend?.url ?? backendRes?.url),
    backendPlan?.healthCheckPath,
  );

  const frontend: FrontendDisplay | null = layers.frontend
    ? {
        state: layerState(layers.frontend),
        openAppUrl: safeExternalHref(layers.frontend.url ?? frontendRes?.url),
        provider: layers.frontend.provider ?? frontendRes?.provider ?? null,
      }
    : null;

  const backend: BackendDisplay | null = layers.backend
    ? {
        state: layerState(layers.backend),
        baseUrl: safeExternalHref(layers.backend.url ?? backendRes?.url),
        healthCheckUrl: safeExternalHref(health?.url),
        healthCheckPassed: Boolean(health?.ok),
        provider: layers.backend.provider ?? backendRes?.provider ?? null,
      }
    : null;

  const database: DatabaseDisplay | null = layers.database
    ? {
        state: layerState(layers.database),
        host: dbRes?.url ?? layers.database.url ?? null,
        provider: layers.database.provider ?? dbRes?.provider ?? null,
        exposesEnv: dbRes?.exposesEnv ?? null,
      }
    : null;

  return { frontend, backend, database, fullStack: layers.fullStack };
}

/** User-facing full-stack summary when backend root may 404 but health passed. */
export function fullStackSummary(display: AppResourceDisplay): string {
  if (display.fullStack.live) {
    return "Frontend loads, backend health check passed, and database is reachable.";
  }
  return display.fullStack.detail;
}
