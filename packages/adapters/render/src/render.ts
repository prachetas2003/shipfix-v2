import {
  diagnoseLogs,
  scrubLogText,
  tailLines,
  type DeployFailureKind,
  type DeployInput,
  type DeployResult,
  type LogDiagnosis,
  type ProviderAdapter,
  type ProviderCredentials,
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
  type?: string;
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
  const build = service.build?.trim();
  const install = service.install?.trim();
  if (build) {
    return `${install ? npmInstallWithDevDeps(install) : "npm install --include=dev"} && ${build}`;
  }
  return install ? npmInstallWithDevDeps(install) : "npm install --include=dev && npm run build";
}

function npmInstallWithDevDeps(command: string): string {
  if (/^npm\s+ci(?:\s|$)/.test(command)) {
    return /\s--include=dev(?:\s|$)/.test(command) ? command : command.replace(/^npm\s+ci/, "npm ci --include=dev");
  }
  if (/^npm\s+install(?:\s|$)/.test(command)) {
    return /\s--include=dev(?:\s|$)/.test(command)
      ? command
      : command.replace(/^npm\s+install/, "npm install --include=dev");
  }
  return command;
}

function renderStartCommand(service: PlanService): string {
  return service.start?.trim() || "npm run start";
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

function renderEnv(input: DeployInput): Record<string, string> {
  if (renderRuntime(input.service) !== "node" || !input.service.build) return input.env;
  return {
    ...input.env,
    NPM_CONFIG_PRODUCTION: "false",
  };
}

const RUNTIME_BY_TYPE: Record<string, "node" | "python" | "docker"> = {
  node_api: "node",
  python_api: "python",
  docker_service: "docker",
};

export function renderRuntime(service: PlanService): "node" | "python" | "docker" | null {
  if (service.type === "worker") return service.runtime ?? "node";
  return RUNTIME_BY_TYPE[service.type] ?? null;
}

/** Background workers have no public URL and no free plan on Render. */
function isWorker(service: PlanService): boolean {
  return service.type === "worker";
}

/**
 * Paths are relative to Render's rootDir. An in-folder Dockerfile uses the
 * service root. A Dockerfile that lives above the service uses its build
 * context (often the repo root) so COPY can see the subfolder.
 */
export function renderBuildRoot(input: DeployInput): string | undefined {
  if (renderRuntime(input.service) === "docker" && input.service.dockerfilePath) {
    return input.service.dockerContext || undefined;
  }
  return input.rootDir || undefined;
}

/** Paths are relative to the service rootDir, which Render uses as the build root. */
export function envSpecificDetails(input: DeployInput): Record<string, string> {
  const runtime = renderRuntime(input.service);
  if (runtime === "docker") {
    const file = input.service.dockerfilePath;
    if (!file) return { dockerfilePath: "./Dockerfile", dockerContext: "." };
    const context = input.service.dockerContext;
    return {
      dockerfilePath: file.startsWith("./") ? file : `./${file}`,
      dockerContext: !context ? "." : context.startsWith("./") ? context : `./${context}`,
    };
  }
  if (runtime === "python") {
    const install = input.service.install?.trim() || "pip install -r requirements.txt";
    const build = input.service.build?.trim();
    return {
      buildCommand: build ? `${install} && ${build}` : install,
      startCommand: input.service.start?.trim() ?? "",
    };
  }
  return {
    buildCommand: renderBuildCommand(input.service),
    startCommand: renderStartCommand(input.service),
  };
}

function buildCreateBody(input: DeployInput, ownerId: string, name: string): Record<string, unknown> {
  return {
    type: isWorker(input.service) ? "background_worker" : "web_service",
    name,
    ownerId,
    repo: `https://github.com/${input.repo.fullName}`,
    branch: input.repo.branch,
    rootDir: renderBuildRoot(input),
    // ShipFix owns deploys (pinned commits, verification after each one); a
    // provider-side push trigger would race it with unverified builds.
    autoDeploy: "no",
    envVars: envVarPayload(renderEnv(input)),
    serviceDetails: {
      runtime: renderRuntime(input.service) ?? "node",
      plan: isWorker(input.service) ? "starter" : "free",
      region: "oregon",
      envSpecificDetails: envSpecificDetails(input),
    },
  };
}

function buildUpdateBody(input: DeployInput): Record<string, unknown> {
  return {
    rootDir: renderBuildRoot(input),
    autoDeploy: "no",
    branch: input.repo.branch,
    serviceDetails: {
      envSpecificDetails: envSpecificDetails(input),
    },
  };
}

/** Replace the service's full env var set (Render's env vars live on their own endpoint). */
async function replaceEnvVars(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
  env: Record<string, string>,
): Promise<void> {
  const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(serviceId)}/env-vars`, apiKey, httpTimeoutMs, {
    method: "PUT",
    body: JSON.stringify(envVarPayload(env)),
  });
  if (!res.ok) await failBody(res, "replace env vars");
}

async function triggerDeploy(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
  commitSha?: string,
): Promise<string | null> {
  const pinned = commitSha && /^[0-9a-f]{7,40}$/i.test(commitSha) ? { commitId: commitSha } : {};
  const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(serviceId)}/deploys`, apiKey, httpTimeoutMs, {
    method: "POST",
    body: JSON.stringify({ clearCache: "do_not_clear", ...pinned }),
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

async function getServiceOrNull(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  httpTimeoutMs: number,
  serviceId: string,
): Promise<RenderService | null> {
  const res = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(serviceId)}`, apiKey, httpTimeoutMs);
  if (res.status === 404) return null;
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

interface RenderLogRow {
  message?: string;
  timestamp?: string;
}

/** Most recent log lines for a service (oldest first). Render caps a page at 100 rows. */
async function fetchRenderLogs(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  ownerId: string,
  serviceId: string,
  type: "build" | "app",
  limit: number,
  httpTimeoutMs: number,
): Promise<string[]> {
  const qs = new URLSearchParams({
    ownerId,
    resource: serviceId,
    type,
    direction: "backward",
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  const res = await apiFetch(fetchImpl, base, `/logs?${qs}`, apiKey, httpTimeoutMs);
  if (!res.ok) await failBody(res, `list ${type} logs`);
  const json = (await parseRenderResponse(res, `list ${type} logs`)) as { logs?: RenderLogRow[] } | RenderLogRow[];
  const rows = Array.isArray(json) ? json : (json.logs ?? []);
  return rows
    .filter((r) => typeof r.message === "string")
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
    .map((r) => r.message!.trimEnd());
}

/**
 * Build log, plus the app log when the build passed but the service never
 * came up. Failures to read logs never mask the deploy failure itself.
 */
async function failureLogs(
  fetchImpl: typeof fetch,
  base: string,
  apiKey: string,
  ownerId: string,
  serviceId: string,
  httpTimeoutMs: number,
  secretValues: string[],
): Promise<{ text: string; diagnosis: LogDiagnosis } | null> {
  const sections: string[] = [];
  for (const type of ["build", "app"] as const) {
    try {
      const lines = await fetchRenderLogs(fetchImpl, base, apiKey, ownerId, serviceId, type, 100, httpTimeoutMs);
      if (lines.length) sections.push(`--- Render ${type} log ---\n${tailLines(lines)}`);
    } catch {
      /* logs are best-effort */
    }
  }
  if (!sections.length) return null;
  const text = scrubLogText(sections.join("\n"), secretValues);
  return { text, diagnosis: diagnoseLogs(text) };
}

function servicePublicUrl(svc: RenderService): string | null {
  const url = svc.serviceDetails?.url;
  if (url && url.startsWith("http")) return url;
  return null;
}

function renderFailureKind(message: string): DeployFailureKind {
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/unauthorized|forbidden|permission|invalid api key|invalid credentials|HTTP 401|HTTP 403/i.test(message)) {
    return "setup_blocker";
  }
  if (/github.*(connect|access|auth)|Login Connection|repository not found/i.test(message)) {
    return "setup_blocker";
  }
  if (/build failed|Exited with status|npm ERR|Module not found|TS\d{4}|ELIFECYCLE|failed to compile/i.test(message)) {
    return "build_failed";
  }
  return "deploy_failed";
}

/**
 * Real Render web-service adapter (REST API: Node, Python, or Dockerfile web
 * services). Create-or-update by stable service name; triggers a deploy and
 * polls until terminal.
 */
export function createRenderAdapter(options: RenderOptions = {}): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBase ?? RENDER_API;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deployTimeoutMs = options.deployTimeoutMs ?? 600_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 120_000;

  return {
    id: "render",
    supports: ["node_api", "python_api", "docker_service", "worker"],

    requiredCredentials() {
      return { provider: "render", required: ["apiKey"], optional: ["ownerId"] };
    },

    async deploy(input: DeployInput): Promise<DeployResult> {
      const apiKey = input.credentials.values.apiKey;
      if (!apiKey) {
        return { ok: false, externalId: null, publicUrl: null, status: "deploy_failed", logs: "Missing Render apiKey.", failureKind: "setup_blocker" };
      }
      if (!renderRuntime(input.service)) {
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: `Render adapter only supports node_api, python_api, docker_service and worker, not "${input.service.type}".`,
        };
      }
      if ((input.service.type === "python_api" || isWorker(input.service)) && !input.service.start?.trim()) {
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: `${isWorker(input.service) ? "Worker" : "Python service"} has no start command.`,
          failureKind: "setup_blocker",
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

      let serviceId: string | undefined;
      try {
        if (input.existingExternalId) {
          const stored = await getServiceOrNull(
            fetchImpl,
            base,
            apiKey,
            httpTimeoutMs,
            input.existingExternalId,
          );
          if (stored?.id) {
            input.onLog?.(`Render: reusing stored service ${stored.id}`);
            const patch = await apiFetch(
              fetchImpl,
              base,
              `/services/${encodeURIComponent(stored.id)}`,
              apiKey,
              httpTimeoutMs,
              {
                method: "PATCH",
                body: JSON.stringify(buildUpdateBody(input)),
              },
            );
            if (!patch.ok) await failBody(patch, "update service");
            await replaceEnvVars(fetchImpl, base, apiKey, httpTimeoutMs, stored.id, renderEnv(input));
            serviceId = stored.id;
          } else {
            input.onLog?.(
              `Render: stored service ${input.existingExternalId} missing — reconciling by name "${stableName}"`,
            );
          }
        }

        if (!serviceId) {
          const existing = await findServiceByName(fetchImpl, base, apiKey, httpTimeoutMs, stableName);
          if (existing?.id) {
            input.onLog?.(`Render: updating existing service ${existing.id}`);
            const patch = await apiFetch(fetchImpl, base, `/services/${encodeURIComponent(existing.id)}`, apiKey, httpTimeoutMs, {
              method: "PATCH",
              body: JSON.stringify(buildUpdateBody(input)),
            });
            if (!patch.ok) await failBody(patch, "update service");
            await replaceEnvVars(fetchImpl, base, apiKey, httpTimeoutMs, existing.id, renderEnv(input));
            serviceId = existing.id;
          } else {
            input.onLog?.(`Render: creating ${isWorker(input.service) ? "background worker" : "web service"} "${stableName}"`);
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
        deployId = await triggerDeploy(fetchImpl, base, apiKey, httpTimeoutMs, serviceId, input.repo.commitSha);
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

      const reachable = !!publicUrl || isWorker(input.service);
      const status: DeployResult["status"] = waited.ok
        ? reachable
          ? "live"
          : "deploy_failed"
        : waited.timedOut
          ? "timeout"
          : "build_failed";
      const ok = waited.ok && reachable;
      const failureKind: DeployFailureKind | undefined = ok
        ? undefined
        : status === "timeout"
          ? "timeout"
          : status === "build_failed"
            ? "build_failed"
            : "deploy_failed";

      const fetched = ok
        ? null
        : await failureLogs(fetchImpl, base, apiKey, ownerId, serviceId, httpTimeoutMs, Object.values(input.env));
      if (fetched) input.onLog?.(`Render: read the failure logs (${fetched.diagnosis.title}).`);

      return {
        ok,
        externalId: serviceId,
        publicUrl,
        status,
        logs: fetched ? `${waited.logs}\n${fetched.text}` : waited.logs,
        ...(failureKind ? { failureKind } : {}),
        ...(fetched ? { diagnosis: fetched.diagnosis } : {}),
      };
    },

    async fetchLogs(externalId, query, credentials) {
      const apiKey = credentials.values.apiKey;
      const ownerId = await resolveOwnerId(fetchImpl, base, credentials, httpTimeoutMs);
      const type = query.kind === "build" ? "build" : "app";
      return fetchRenderLogs(fetchImpl, base, apiKey, ownerId, externalId, type, query.limit ?? 100, httpTimeoutMs);
    },

    async waitForReady(externalId, credentials) {
      const apiKey = credentials.values.apiKey;
      try {
        const svc = await getService(fetchImpl, base, apiKey, httpTimeoutMs, externalId);
        const publicUrl = servicePublicUrl(svc);
        const ready = !!publicUrl || svc.type === "background_worker";
        return {
          ok: ready,
          externalId,
          publicUrl,
          status: ready ? "live" : "deploy_failed",
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
      // Upsert individual keys; other env vars on the service are left untouched.
      const apiKey = credentials.values.apiKey;
      for (const [key, value] of Object.entries(env)) {
        const res = await apiFetch(
          fetchImpl,
          base,
          `/services/${encodeURIComponent(externalId)}/env-vars/${encodeURIComponent(key)}`,
          apiKey,
          httpTimeoutMs,
          { method: "PUT", body: JSON.stringify({ value }) },
        );
        if (!res.ok) await failBody(res, `set env ${key}`);
      }
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
