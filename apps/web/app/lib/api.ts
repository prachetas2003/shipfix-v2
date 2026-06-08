/** Typed client for the ShipFix control-plane API. */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function getAlphaToken(): string | null {
  if (typeof window !== "undefined") {
    const existing = window.localStorage.getItem("shipfix_alpha_token");
    if (existing) return existing;
    const entered = window.prompt("Enter your ShipFix alpha access token");
    if (!entered?.trim()) return null;
    window.localStorage.setItem("shipfix_alpha_token", entered.trim());
    return entered.trim();
  }
  return null;
}

function authHeaders(): Record<string, string> {
  const token = getAlphaToken();
  return token ? { "X-ShipFix-Alpha-User": token } : {};
}

export function withAlphaTokenQuery(url: string): string {
  const token = getAlphaToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}alpha_token=${encodeURIComponent(token)}`;
}

export type LayerRole = "database" | "backend" | "frontend" | "other";
export type LayerState = "live" | "failed" | "provisioning" | "not_attempted";

export interface SnapshotResource {
  serviceId: string;
  role: LayerRole;
  kind: string;
  provider: string;
  url: string | null;
  status: string;
  exposesEnv: string | null;
}

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

export interface VerificationEntry {
  serviceId: string;
  check: string;
  ok: boolean;
  skipped: boolean;
  statusCode: number | null;
  url: string | null;
  assumedPath: boolean;
}

export interface RunMeta {
  id: string;
  mode: string;
  status: string;
  repoFullName: string | null;
  branch: string | null;
  commitSha: string;
  startedAt: string;
  finishedAt: string | null;
  projectId: string;
}

export interface RunSnapshot {
  run: RunMeta;
  plan: PlanView | null;
  resources: SnapshotResource[];
  verification: VerificationEntry[];
  layers: RunLayers;
}

export interface AppSummary {
  projectId: string;
  repoFullName: string;
  defaultBranch: string;
  latestRun: {
    id: string;
    mode: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  resources: SnapshotResource[];
  layers: RunLayers | null;
  verification: VerificationEntry[];
  liveDeployment: {
    runId: string;
    status: string;
    resources: SnapshotResource[];
    layers: RunLayers;
    verification: VerificationEntry[];
  } | null;
}

export interface AppDetail {
  project: { id: string; repoFullName: string; defaultBranch: string; createdAt: string };
  current: {
    resources: SnapshotResource[];
    layers: RunLayers;
    runId: string;
    verification: VerificationEntry[];
  } | null;
  latestLiveDeployment: {
    runId: string;
    status: string;
    resources: SnapshotResource[];
    layers: RunLayers;
    verification: VerificationEntry[];
  } | null;
  history: Array<{
    id: string;
    mode: string;
    status: string;
    commitSha: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
}

// ── Plan view (names only; never secret values) ──────────────────────────────
export interface PlanEnvVar { name: string; source: string; ref?: string; value?: string }
export interface PlanService {
  id: string;
  type: string;
  provider: string;
  rootDir: string;
  install: string | null;
  build: string | null;
  start: string | null;
  outputDir: string | null;
  healthCheckPath: string | null;
  env: PlanEnvVar[];
}
export interface PlanManaged { id: string; kind: string; mode: string; provider?: string; exposesEnv: string; migration: string }
export interface PlanWiring { fromServiceId: string; fromField: string; toServiceId: string; toEnvName: string }
export interface PlanQuestion { id: string; prompt: string; kind: string; options?: string[]; default?: string }
export interface PlanBlocker { severity: string; title: string; explanation: string; action: string }
export interface PlanView {
  goal: string;
  classification: "deployable" | "needs_setup" | "diagnose_only";
  services: PlanService[];
  managed: PlanManaged[];
  wiring: PlanWiring[];
  deployOrder: string[];
  questions: PlanQuestion[];
  blockers: PlanBlocker[];
  confidence: number;
}

export interface RunEventRow {
  seq: number;
  type: string;
  stage: string | null;
  level: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type RunMode = "analyze_only" | "plan" | "deploy";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  listApps: () => getJson<{ apps: AppSummary[] }>("/apps"),
  getApp: (projectId: string) => getJson<AppDetail>(`/apps/${projectId}`),
  getRunSnapshot: (runId: string) => getJson<RunSnapshot>(`/runs/${runId}`),
  listProviders: () =>
    getJson<{ connected: string[]; provisionable: string[]; deployable: string[] }>("/providers"),

  async startRun(mode: RunMode, repo: string): Promise<string> {
    const value = repo.trim();
    const isUrl = /^https?:\/\//i.test(value);
    const path = mode === "deploy" ? "/runs/deploy" : mode === "plan" ? "/runs/plan" : "/runs/analyze";
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(isUrl ? { repoUrl: value } : { repoFullName: value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    return body.runId as string;
  },

  async connectProvider(provider: string, values: Record<string, string>): Promise<void> {
    const res = await fetch(`${API_BASE}/provider-accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        provider,
        values: Object.fromEntries(
          Object.entries(values)
            .map(([key, raw]) => [key, raw.trim()])
            .filter(([, raw]) => raw.length > 0),
        ),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  },
};
