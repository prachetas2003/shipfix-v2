import type {
  DeployFailureKind,
  DeployInput,
  DeployResult,
  ProviderAdapter,
  ProviderCredentials,
} from "@shipfix/adapter-core";
import type { PlanService } from "@shipfix/contracts";
import {
  formatDeployFailureDetail,
  parseRenderResponse,
  renderApiError,
} from "./renderHttp.js";

const RENDER_API = "https://api.render.com/v1";

export interface RenderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** Max wait for a single Render API HTTP request (ms). */
  httpTimeoutMs?: number;
  /** Poll interval while waiting for deploy (ms). */
  pollIntervalMs?: number;
  /** Max wait for deploy to finish (ms). */
  deployTimeoutMs?: number;
}

interface RenderService {
  id?: string;
  name?: string;
  serviceDetails?: {
    url?: string;
    buildCommand?: string;
    startCommand?: string;
  };
}

interface RenderDeploy {
  id?: string;
  status?: string;
}

/** Render list endpoints return cursor-wrapped rows. */
function unwrapService(row: unknown): RenderService | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const svc = (r.service ?? r) as RenderService;
  return svc?.id ? svc : null;
}

async function apiFetch(
  fetchImpl: typeof fetch,
  base: string,
  path: string,
  apiKey: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Render API request timed out after ${timeoutMs}ms (${path})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function failBody(res: Response, action: string): Promise<never> {
  const body = await res.text().catch(() => "");
  throw renderApiError(action, res, body);
}

/** Render build command: install then build (plan fields), for rootDir sub-apps. */
function renderBuildCommand(service: PlanService): string {
  const parts = [service.install, service.build].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" && ") : "npm install && npm run build";
}

/** Resolve workspace owner id (required by Render create). Uses stored ownerId or GET /owners. */
async function resolveOwnerId(
  fetchImpl: typeof fetch,
  base: string,
  creds: ProviderCredentials,
  httpTimeoutMs: number,
): Promise<string> {
  if (creds.values.ownerId) return creds.values.ownerId;
  const res = await apiFetch(fetchImpl, base, "/owners?limit=20", creds.values.apiKey, httpTimeoutMs);
  if (!res.ok) await failBody(res, "list owners");
  const rows = (await parseRenderResponse(res, "list owners")) as unknown[];
  for (const row of rows) {
    const o = row as { owner?: { id?: string }; id?: string };
    const id = o.owner?.id ?? o.id;
    if (id) return id;
  }
  throw new Error("Render API returned no owners. Set ownerId in connected credentials.");
}

/** Find an existing service by deterministic name (idempotent deploy). */
async function findServiceByName(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  name: string,
): Promise<RenderService | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const res = await apiFetch(fetchImpl, base, `/services?${qs}`, apiKey, httpTimeoutMs);
    if (!res.ok) await failBody(res, "list services");
    const rows = (await parseRenderResponse(res, "list services")) as unknown[];
    for (const row of rows) {
      const svc = unwrapService(row);
      if (svc?.name === name) return svc;
      const c = (row as { cursor?: string }).cursor;
      if (c) cursor = c;
    }
    if (rows.length < 100) break;
  }
  return null;
}

function envVarPayload(env: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function buildCreateBody(input: DeployInput, ownerId: string, name: string): Record<string, unknown> {
  const build = renderBuildCommand(input.service);
  const start = input.service.start ?? undefined;
  return {
    type: "web_service",
    name,
    ownerId,
    repo: `https://github.com/${input.repo.fullName}`,
    branch: input.repo.branch,
    rootDir: input.rootDir || undefined,
    autoDeploy: "yes",
    envVars: envVarPayload(input.env),
    serviceDetails: {
      runtime: "node",
      plan: "free",
      region: "oregon",
      envSpecificDetails: {
        buildCommand: build,
        startCommand: start || "npm start",
      },
    },
  };
}

function buildUpdateBody(input: DeployInput): Record<string, unknown> {
  const build = renderBuildCommand(input.service);
  const start = input.service.start ?? undefined;
  return {
    rootDir: input.rootDir || undefined,
    envVars: envVarPayload(input.env),
    serviceDetails: {
      envSpecificDetails: {
        buildCommand: build,
        startCommand: start || "npm start",
      },
    },
  };
}

async function triggerDeploy(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
): Promise<string | null> {
  const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(serviceId)}/deploys`, apiKey, httpTimeoutMs, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) await failBody(res, "trigger deploy");
  const json = (await parseRenderResponse(res, "trigger deploy", { allowEmptyOk: true })) as {
    id?: string;
    deploy?: { id?: string };
  } | null;
  return json?.deploy?.id ?? json?.id ?? null;
}

/** When POST /deploys returns an empty 2xx body, resolve the newest deploy id. */
async function findLatestDeployId(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
): Promise<string | null> {
  const res = await apiFetch(
    fetchImpl,
    base,
    `/services/${encodeURIComponent(serviceId)}/deploys?limit=5`,
    apiKey,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res, "list deploys");
  const rows = (await parseRenderResponse(res, "list deploys")) as unknown[];
  for (const row of rows) {
    const r = row as { deploy?: RenderDeploy; id?: string };
    const id = r.deploy?.id ?? r.id;
    if (id) return id;
  }
  return null;
}

async function getService(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
): Promise<RenderService> {
  const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(serviceId)}`, apiKey, httpTimeoutMs);
  if (!res.ok) await failBody(res, "get service");
  const json = await parseRenderResponse(res, "get service");
  return unwrapService(json) ?? (json as RenderService);
}

async function getDeploy(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  serviceId: string,
  deployId: string,
  httpTimeoutMs: number,
): Promise<RenderDeploy> {
  const res = await apiFetch(
    fetchImpl,
    base,
    `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    apiKey,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res, "get deploy");
  const json = (await parseRenderResponse(res, "get deploy")) as { deploy?: RenderDeploy };
  return json.deploy ?? (json as RenderDeploy);
}

const TERMINAL_DEPLOY = new Set(["live", "deactivated", "build_failed", "update_failed", "canceled"]);

async function waitForDeploy(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  serviceId: string,
  deployId: string,
  opts: Required<Pick<RenderOptions, "pollIntervalMs" | "deployTimeoutMs" | "httpTimeoutMs">>,
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; logs: string; timedOut: boolean }> {
  const deadline = Date.now() + opts.deployTimeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const d = await getDeploy(fetchImpl, base, apiKey, serviceId, deployId, opts.httpTimeoutMs);
    if (d.status && d.status !== lastStatus) {
      lastStatus = d.status;
      onLog?.(`Deploy status: ${d.status}`);
    }
    if (d.status && TERMINAL_DEPLOY.has(d.status)) {
      const ok = d.status === "live";
      const logs = ok
        ? `deploy ${deployId} ended ${d.status}`
        : formatDeployFailureDetail({
            serviceId,
            deployId,
            action: "deploy",
            status: d.status,
          });
      return { ok, logs, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
  return {
    ok: false,
    timedOut: true,
    logs: formatDeployFailureDetail({
      serviceId,
      deployId,
      action: "deploy",
      status: "timeout",
      extra: `timed out after ${opts.deployTimeoutMs}ms`,
    }),
  };
}

function servicePublicUrl(svc: RenderService): string | null {
  const url = svc.serviceDetails?.url;
  if (url && url.startsWith("http")) return url;
  return null;
}

function renderFailureKind(message: string): DeployFailureKind {
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/owner|unauthorized|forbidden|permission|repo|github|not found|api key/i.test(message)) {
    return "setup_blocker";
  }
  return "deploy_failed";
}

/**
 * Real Render web-service adapter (REST API, node_api only). Create-or-update by
 * stable service name; triggers a deploy and polls until terminal.
 */
export function createRenderAdapter(options: RenderOptions = {}): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBase ?? RENDER_API;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deployTimeoutMs = options.deployTimeoutMs ?? 600_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 120_000;

  return {
    id: "render",
    supports: ["node_api"],

    requiredCredentials() {
      return { provider: "render", required: ["apiKey"], optional: ["ownerId"] };
    },

    async deploy(input: DeployInput): Promise<DeployResult> {
      const apiKey = input.credentials.values.apiKey;
      if (!apiKey) {
        return { ok: false, externalId: null, publicUrl: null, status: "deploy_failed", logs: "Missing Render apiKey.", failureKind: "setup_blocker" };
      }
      if (input.service.type !== "node_api") {
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: `Render adapter only supports node_api, not "${input.service.type}".`,
        };
      }

      const stableName = (input.resourceName ?? `shipfix-${input.service.id}`).slice(0, 60);
      input.onLog?.(`Render: resolving workspace for "${stableName}"`);

      let ownerId: string;
      try {
        ownerId = await resolveOwnerId(fetchImpl, base, input.credentials, httpTimeoutMs);
      } catch (e) {
        const logs = e instanceof Error ? e.message : String(e);
        const failureKind = renderFailureKind(logs);
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: failureKind === "timeout" ? "timeout" : "deploy_failed",
          logs,
          failureKind,
        };
      }

      let serviceId: string;
      try {
        const existing = await findServiceByName(fetchImpl, base, apiKey, httpTimeoutMs, stableName);
        if (existing?.id) {
          input.onLog?.(`Render: updating existing service ${existing.id}`);
          const patch = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(existing.id)}`, apiKey, httpTimeoutMs, {
            method: "PATCH",
            body: JSON.stringify(buildUpdateBody(input)),
          });
          if (!patch.ok) await failBody(patch, "update service");
          serviceId = existing.id;
        } else {
          input.onLog?.(`Render: creating web service "${stableName}"`);
          const res = await apiFetch(fetchImpl, base, "/services", apiKey, httpTimeoutMs, {
            method: "POST",
            body: JSON.stringify(buildCreateBody(input, ownerId, stableName)),
          });
          if (!res.ok) await failBody(res, "create service");
          const created = unwrapService(await parseRenderResponse(res, "create service"));
          if (!created?.id) {
            return {
              ok: false,
              externalId: null,
              publicUrl: null,
              status: "deploy_failed",
              logs: formatDeployFailureDetail({
                serviceId: "unknown",
                action: "create service",
                extra: "response did not include a service id",
              }),
            };
          }
          serviceId = created.id;
        }
      } catch (e) {
        const logs = e instanceof Error ? e.message : String(e);
        const failureKind = renderFailureKind(logs);
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: failureKind === "timeout" ? "timeout" : "deploy_failed",
          logs,
          failureKind,
        };
      }

      input.onLog?.(`Render: triggering deploy for ${serviceId}`);
      let deployId: string | null;
      try {
        deployId = await triggerDeploy(fetchImpl, base, apiKey, httpTimeoutMs, serviceId);
        if (!deployId) {
          deployId = await findLatestDeployId(fetchImpl, base, apiKey, httpTimeoutMs, serviceId);
        }
      } catch (e) {
        const logs = e instanceof Error ? e.message : String(e);
        const failureKind = renderFailureKind(logs);
        return {
          ok: false,
          externalId: serviceId,
          publicUrl: null,
          status: failureKind === "timeout" ? "timeout" : "deploy_failed",
          logs,
          failureKind,
        };
      }

      if (!deployId) {
        return {
          ok: false,
          externalId: serviceId,
          publicUrl: null,
          status: "deploy_failed",
          logs: formatDeployFailureDetail({
            serviceId,
            action: "trigger deploy",
            extra: "no deploy id returned",
          }),
        };
      }

      const waited = await waitForDeploy(fetchImpl, base, apiKey, serviceId, deployId, {
        pollIntervalMs,
        deployTimeoutMs,
        httpTimeoutMs,
      }, input.onLog);

      let publicUrl: string | null = null;
      try {
        const svc = await getService(fetchImpl, base, apiKey, httpTimeoutMs, serviceId);
        publicUrl = servicePublicUrl(svc);
      } catch {
        /* url may appear later; waitForDeploy outcome still matters */
      }

      const status: DeployResult["status"] = waited.ok
        ? publicUrl
          ? "live"
          : "deploy_failed"
        : waited.timedOut
          ? "timeout"
          : "build_failed";
      const ok = waited.ok && !!publicUrl;
      const failureKind: DeployFailureKind | undefined = ok
        ? undefined
        : status === "timeout"
          ? "timeout"
          : status === "build_failed"
            ? "build_failed"
            : "deploy_failed";

      return {
        ok,
        externalId: serviceId,
        publicUrl,
        status,
        logs: waited.logs,
        ...(failureKind ? { failureKind } : {}),
      };
    },

    async waitForReady(externalId, credentials) {
      const apiKey = credentials.values.apiKey;
      try {
        const svc = await getService(fetchImpl, base, apiKey, httpTimeoutMs, externalId);
        const publicUrl = servicePublicUrl(svc);
        return {
          ok: !!publicUrl,
          externalId,
          publicUrl,
          status: publicUrl ? "live" : "deploy_failed",
          logs: "",
        };
      } catch (e) {
        return {
          ok: false,
          externalId,
          publicUrl: null,
          status: "deploy_failed",
          logs: e instanceof Error ? e.message : String(e),
        };
      }
    },

    async setEnv(externalId, env, credentials) {
      const apiKey = credentials.values.apiKey;
      const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(externalId)}`, apiKey, httpTimeoutMs, {
        method: "PATCH",
        body: JSON.stringify({ envVars: envVarPayload(env) }),
      });
      if (!res.ok) await failBody(res, "set env");
    },

    async teardown(externalId, credentials) {
      const apiKey = credentials.values.apiKey;
      if (!apiKey || !externalId) return;
      await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(externalId)}`, apiKey, httpTimeoutMs, {
        method: "DELETE",
      });
    },
  };
}
