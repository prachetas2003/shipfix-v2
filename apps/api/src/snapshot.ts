/**
 * Pure helpers that turn raw control-plane rows (runs, plans, deployed_resources,
 * run_events) into the beginner-facing snapshot the web app renders: per-layer
 * status (database / backend / frontend / full-stack), resource links, and a
 * verification summary. Never touches secret columns (enc_blob/enc_iv/enc_dek).
 */

import { accountVerificationEvents } from "@shipfix/verifier";

export type LayerRole = "database" | "backend" | "frontend" | "other";

export interface RawResourceRow {
  serviceId: string;
  kind: string; // 'service' | 'managed_db' | 'managed_redis'
  provider: string;
  externalId: string | null;
  url: string | null;
  status: string; // 'provisioning' | 'live' | 'failed'
  exposesEnv: string | null;
  createdAt: Date | string;
  /** Non-secret provider metadata (e.g. consoleUrl, resourceName). */
  meta?: Record<string, unknown> | null;
}

export interface PlanServiceLite {
  id: string;
  type: string; // 'node_api' | 'frontend_static' | 'frontend_ssr' | ...
  provider?: string | null;
  healthCheckPath?: string | null;
}

function isFrontendServiceType(type: string): boolean {
  return type === "frontend_static" || type === "frontend_ssr";
}

function isBackendServiceType(type: string): boolean {
  return type === "node_api";
}

export interface PlanLite {
  services?: PlanServiceLite[];
  managed?: Array<{ kind?: string; provider?: string | null; exposesEnv?: string }>;
  verification?: Array<{ serviceId?: string; check?: string; target?: string }>;
}

export interface SnapshotResource {
  serviceId: string;
  role: LayerRole;
  kind: string;
  provider: string;
  url: string | null;
  status: string;
  exposesEnv: string | null;
  /** Provider resource id (safe to expose; used for console deep links). */
  externalId?: string | null;
  /** Provider dashboard URL when known (never a secret). */
  consoleUrl?: string | null;
}

/** Best-effort provider console URL from external id (non-secret). */
export function providerConsoleUrl(
  provider: string,
  externalId: string | null | undefined,
  meta?: Record<string, unknown> | null,
): string | null {
  const fromMeta = meta?.consoleUrl;
  if (typeof fromMeta === "string" && /^https?:\/\//i.test(fromMeta)) return fromMeta;
  if (!externalId) return null;
  const id = encodeURIComponent(externalId);
  if (provider === "render") return `https://dashboard.render.com/web/${id}`;
  if (provider === "neon") return `https://console.neon.tech/app/projects/${id}`;
  // Vercel needs team slug + project name; prefer meta.consoleUrl written at deploy time.
  return null;
}

export interface VerificationEntry {
  serviceId: string;
  check: string;
  ok: boolean;
  skipped: boolean;
  statusCode: number | null;
  url: string | null;
  assumedPath: boolean;
}

export interface SnapshotDiagnosis {
  code: string;
  action: string;
  fromServiceId?: string;
  toServiceId?: string;
  serviceId?: string;
  managedId?: string;
  fromUrl?: string | null;
  toUrl?: string | null;
  evidence?: Record<string, unknown>;
}

export type LayerState = "live" | "failed" | "provisioning" | "not_attempted";

export interface LayerStatus {
  state: LayerState;
  url: string | null;
  provider: string | null;
  detail: string;
}

export interface RunLayers {
  database: LayerStatus | null;
  backend: LayerStatus | null;
  frontend: LayerStatus | null;
  fullStack: { live: boolean; detail: string };
}

/** Decide a resource's product layer from the plan (preferred) or provider. */
export function roleForResource(row: RawResourceRow, plan: PlanLite | null): LayerRole {
  if (row.kind !== "service") return "database";
  const svc = plan?.services?.find((s) => s.id === row.serviceId);
  if (svc) {
    if (isFrontendServiceType(svc.type)) return "frontend";
    if (isBackendServiceType(svc.type)) return "backend";
    return "other";
  }
  if (row.provider === "vercel") return "frontend";
  if (row.provider === "render") return "backend";
  return "other";
}

/**
 * Collapse possibly-duplicate rows (one insert per deploy attempt, no unique
 * index) to the latest row per serviceId, preferring a live row if present.
 */
export function latestResourceRows(rows: RawResourceRow[]): RawResourceRow[] {
  const byService = new Map<string, RawResourceRow>();
  const ts = (r: RawResourceRow): number => new Date(r.createdAt).getTime();
  for (const row of rows) {
    const existing = byService.get(row.serviceId);
    if (!existing) {
      byService.set(row.serviceId, row);
      continue;
    }
    const existingLive = existing.status === "live";
    const rowLive = row.status === "live";
    if (rowLive && !existingLive) byService.set(row.serviceId, row);
    else if (rowLive === existingLive && ts(row) >= ts(existing)) byService.set(row.serviceId, row);
  }
  return [...byService.values()];
}

export function toSnapshotResources(rows: RawResourceRow[], plan: PlanLite | null): SnapshotResource[] {
  return latestResourceRows(rows).map((row) => ({
    serviceId: row.serviceId,
    role: roleForResource(row, plan),
    kind: row.kind,
    provider: row.provider,
    url: row.url,
    status: row.status,
    exposesEnv: row.exposesEnv,
    externalId: row.externalId,
    consoleUrl: providerConsoleUrl(row.provider, row.externalId, row.meta),
  }));
}

/** Extract verification check results from run_events data payloads. */
export function verificationFromEvents(
  events: Array<{ data: unknown }>,
): VerificationEntry[] {
  const out: VerificationEntry[] = [];
  for (const e of events) {
    const d = e.data as Record<string, unknown> | null;
    if (!d || d.event !== "verification") continue;
    out.push({
      serviceId: String(d.serviceId ?? d.managedId ?? ""),
      check: String(d.check ?? ""),
      ok: Boolean(d.ok),
      skipped: Boolean(d.skipped),
      statusCode: typeof d.statusCode === "number" ? d.statusCode : null,
      url: d.url ? String(d.url) : null,
      assumedPath: Boolean(d.assumedPath),
    });
  }
  return out;
}

/** Extract structured diagnoses from run_events data payloads. */
export function diagnosesFromEvents(
  events: Array<{ data: unknown }>,
): SnapshotDiagnosis[] {
  const out: SnapshotDiagnosis[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const d = e.data as Record<string, unknown> | null;
    if (!d) continue;
    const raw = d.diagnosis;
    if (!raw || typeof raw !== "object") continue;
    const diag = raw as Record<string, unknown>;
    const code = typeof diag.code === "string" ? diag.code : null;
    const action = typeof diag.action === "string" ? diag.action : null;
    if (!code || !action) continue;
    const key = `${code}:${String(diag.serviceId ?? diag.managedId ?? diag.toServiceId ?? "")}:${String(diag.fromServiceId ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code,
      action,
      fromServiceId: typeof diag.fromServiceId === "string" ? diag.fromServiceId : undefined,
      toServiceId: typeof diag.toServiceId === "string" ? diag.toServiceId : undefined,
      serviceId: typeof diag.serviceId === "string" ? diag.serviceId : undefined,
      managedId: typeof diag.managedId === "string" ? diag.managedId : undefined,
      fromUrl: diag.fromUrl == null ? null : String(diag.fromUrl),
      toUrl: diag.toUrl == null ? null : String(diag.toUrl),
      evidence:
        diag.evidence && typeof diag.evidence === "object"
          ? (diag.evidence as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

function layerFromResource(res: SnapshotResource | undefined, planned: boolean): LayerStatus | null {
  if (!res) {
    return planned
      ? { state: "not_attempted", url: null, provider: null, detail: "Not deployed yet." }
      : null;
  }
  const state: LayerState =
    res.status === "live" ? "live" : res.status === "provisioning" ? "provisioning" : "failed";
  const detail =
    state === "live"
      ? "Live and reachable."
      : state === "provisioning"
        ? "Provisioning."
        : "Deployment did not complete.";
  return { state, url: res.url, provider: res.provider, detail };
}

/** Per-layer status plus an honest full-stack roll-up. */
export function deriveLayers(
  resources: SnapshotResource[],
  plan: PlanLite | null,
  verification: VerificationEntry[] = [],
): RunLayers {
  const services = plan?.services ?? [];
  const backendService = services.find((s) => isBackendServiceType(s.type));
  const frontendService = services.find((s) => isFrontendServiceType(s.type));

  const resourceFor = (serviceId: string | undefined): SnapshotResource | undefined =>
    serviceId ? resources.find((r) => r.serviceId === serviceId) : undefined;

  const byRole = (role: LayerRole): SnapshotResource | undefined =>
    resources.find((r) => r.role === role);

  const plannedFrontend = services.some((s) => isFrontendServiceType(s.type));
  const plannedBackend = services.some((s) => isBackendServiceType(s.type));
  const plannedDb = (plan?.managed?.length ?? 0) > 0 || !!byRole("database");

  const database = layerFromResource(byRole("database"), plannedDb);
  const backend = layerFromResource(
    resourceFor(backendService?.id) ?? byRole("backend"),
    plannedBackend,
  );
  const frontend = layerFromResource(
    resourceFor(frontendService?.id) ?? byRole("frontend"),
    plannedFrontend,
  );

  const requiredLayers = [database, backend, frontend].filter(
    (l): l is LayerStatus => l !== null,
  );
  const resourcesLive = requiredLayers.length > 0 && requiredLayers.every((l) => l.state === "live");
  const verificationSummary = accountVerificationEvents(plan ?? {}, verification);
  const optionalIssues = [
    ...verificationSummary.optionalFailed,
    ...verificationSummary.optionalSkipped,
  ];
  const allLive = resourcesLive && verificationSummary.allRequiredPassed;
  const fullStack = {
    live: allLive,
    detail: allLive
      ? optionalIssues.length > 0
        ? "Your app is live. Optional wiring checks did not fully pass — see timeline."
        : "Your app is live."
      : resourcesLive && verificationSummary.requiredFailed.length > 0
        ? "All parts have URLs, but live verification failed."
        : resourcesLive && !verificationSummary.allRequiredPassed
          ? "All parts have URLs, but ShipFix has not proven the full app works yet."
          : frontend && frontend.state !== "live"
            ? "Backend may be live, but the frontend is not deployed/verified yet."
            : "Not all parts of the app are live yet.",
  };

  return { database, backend, frontend, fullStack };
}
