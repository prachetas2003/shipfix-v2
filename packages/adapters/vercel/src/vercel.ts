import type {
  DeployFailureKind,
  DeployInput,
  DeployResult,
  ProviderAdapter,
  ProviderCredentials,
} from "@shipfix/adapter-core";
import { resolveGitRepoId } from "./resolveGitRepoId.js";
import { failVercelBody, parseVercelJson } from "./vercelHttp.js";
import { buildGitSource, VercelRepoIdError } from "./vercelGit.js";
import { buildProjectBody, buildProjectPatch } from "./vercelProject.js";
import {
  DEFAULT_VERCEL_DEPLOY_TIMEOUT_MS,
  DEFAULT_VERCEL_HTTP_TIMEOUT_MS,
  vercelApiFetch,
} from "./vercelFetch.js";

const VERCEL_API = "https://api.vercel.com";

export interface VercelOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  pollIntervalMs?: number;
  /** Wall-clock max wait for deployment READY/ERROR (default 15 min). */
  deployTimeoutMs?: number;
  /** Per HTTP request timeout (default 2 min). */
  httpTimeoutMs?: number;
}

interface VercelProject {
  id?: string;
  name?: string;
}

interface VercelDeployment {
  id?: string;
  url?: string;
  readyState?: string;
  alias?: string[];
}

interface VercelProjectTargets {
  production?: { alias?: string[]; url?: string };
}

interface VercelProjectDetail {
  id?: string;
  name?: string;
  alias?: Array<{ domain?: string }> | string[];
  targets?: VercelProjectTargets;
}

/** Normalize a bare host or full URL into an https URL, or null. */
function toHttps(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}


async function failBody(res: Response): Promise<never> {
  return failVercelBody(res, "request");
}

function statusFromFailure(
  failureKind: DeployFailureKind,
  ready: boolean,
  hasUrl: boolean,
  timedOut: boolean,
): DeployResult["status"] {
  if (ready && hasUrl) return "live";
  if (timedOut) return "timeout";
  if (failureKind === "build_failed") return "build_failed";
  return "deploy_failed";
}

function deployError(e: unknown): { logs: string; failureKind: DeployFailureKind } {
  if (e instanceof VercelRepoIdError) {
    return { logs: e.message, failureKind: e.failureKind };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/GitHub connection required|Login Connection|git repoId unresolved|requires a linked GitHub repoId/i.test(msg)) {
    return { logs: msg, failureKind: "setup_blocker" };
  }
  if (/timed out|timeout/i.test(msg)) {
    return { logs: msg, failureKind: "timeout" };
  }
  return { logs: msg, failureKind: "deploy_failed" };
}

function creds(input: ProviderCredentials): { token: string; teamId?: string } {
  const token = input.values.apiToken;
  if (!token) throw new Error("Missing Vercel apiToken.");
  return { token, teamId: input.values.teamId };
}

async function findProjectByName(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  name: string,
): Promise<VercelProject | null> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v9/projects?search=${encodeURIComponent(name)}&limit=20`,
    token,
    teamId,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res);
  const json = await parseVercelJson<{ projects?: VercelProject[] }>(res, "list projects");
  return json.projects?.find((p) => p.name === name) ?? null;
}

async function upsertProject(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  input: DeployInput,
  name: string,
): Promise<string> {
  const existing = await findProjectByName(fetchImpl, base, token, teamId, httpTimeoutMs, name);
  if (existing?.id) {
    const patch = await vercelApiFetch(
      fetchImpl,
      base,
      `/v9/projects/${encodeURIComponent(existing.id)}`,
      token,
      teamId,
      httpTimeoutMs,
      { method: "PATCH", body: JSON.stringify(buildProjectPatch(input)) },
    );
    if (!patch.ok) await failBody(patch);
    return existing.id;
  }
  const res = await vercelApiFetch(fetchImpl, base, "/v11/projects", token, teamId, httpTimeoutMs, {
    method: "POST",
    body: JSON.stringify(buildProjectBody(input, name)),
  });
  if (!res.ok) await failBody(res);
  const created = await parseVercelJson<VercelProject>(res, "create project");
  if (!created.id) throw new Error("Vercel create project response did not include an id.");
  return created.id;
}

async function setProjectEnv(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  env: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(env)) {
    const res = await vercelApiFetch(
      fetchImpl,
      base,
      `/v10/projects/${encodeURIComponent(projectId)}/env`,
      token,
      teamId,
      httpTimeoutMs,
      {
        method: "POST",
        body: JSON.stringify({ key, value, type: "plain", target: ["production", "preview"] }),
      },
    );
    if (!res.ok) await failBody(res);
  }
}

async function triggerGitDeployment(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  projectName: string,
  input: DeployInput,
  repoId: string,
): Promise<{ deployId: string; url: string | null }> {
  const gitSource = buildGitSource(repoId, input.repo.branch, input.repo.commitSha);

  const res = await vercelApiFetch(fetchImpl, base, "/v13/deployments", token, teamId, httpTimeoutMs, {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      project: projectId,
      target: "production",
      gitSource,
    }),
  });
  if (!res.ok) await failBody(res);
  const json = await parseVercelJson<{
    id?: string;
    url?: string;
    deployment?: { id?: string; url?: string };
  }>(res, "create deployment");
  const deployId = json.deployment?.id ?? json.id;
  if (!deployId) throw new Error("Vercel did not return a deployment id.");
  // Vercel returns the deployment host on create; keep it as an early fallback
  // so a successful deploy is never invisible just because alias attach lagged.
  const url = toHttps(json.deployment?.url ?? json.url ?? null);
  return { deployId, url };
}

/**
 * Read a project's production URL (alias or last production deployment). Used as
 * a fallback when a deployment is READY but its alias has not propagated yet,
 * and as a final reconcile after a poll timeout. Never throws.
 */
async function getProjectProductionUrl(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
): Promise<string | null> {
  try {
    const res = await vercelApiFetch(
      fetchImpl,
      base,
      `/v9/projects/${encodeURIComponent(projectId)}`,
      token,
      teamId,
      httpTimeoutMs,
    );
    if (!res.ok) return null;
    const p = await parseVercelJson<VercelProjectDetail>(res, "get project");
    const prod = p.targets?.production;
    const prodAlias = prod?.alias?.find((a) => !!a);
    if (prodAlias) return toHttps(prodAlias);
    if (prod?.url) return toHttps(prod.url);
    const first = p.alias?.[0];
    if (typeof first === "string") return toHttps(first);
    if (first && typeof first === "object" && "domain" in first) return toHttps(first.domain);
    return null;
  } catch {
    return null;
  }
}

async function getDeployment(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  deploymentId: string,
): Promise<VercelDeployment> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    token,
    teamId,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res);
  return parseVercelJson<VercelDeployment>(res, "get deployment");
}

const TERMINAL = new Set(["READY", "ERROR", "CANCELED"]);

async function waitForDeployment(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  deploymentId: string,
  opts: Required<Pick<VercelOptions, "pollIntervalMs" | "deployTimeoutMs">>,
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; timedOut: boolean; logs: string; deployment: VercelDeployment }> {
  const deadline = Date.now() + opts.deployTimeoutMs;
  let lastState = "";
  while (Date.now() < deadline) {
    const d = await getDeployment(fetchImpl, base, token, teamId, httpTimeoutMs, deploymentId);
    const state = d.readyState ?? "";
    if (state && state !== lastState) {
      lastState = state;
      onLog?.(`Deployment status: ${state}`);
    }
    if (state && TERMINAL.has(state)) {
      return {
        ok: state === "READY",
        timedOut: false,
        logs: `deployment ${deploymentId} ended ${state}`,
        deployment: d,
      };
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
  return {
    ok: false,
    timedOut: true,
    logs: `Frontend deployment timed out on Vercel after ${opts.deployTimeoutMs}ms (deployment ${deploymentId})`,
    deployment: {},
  };
}

function deploymentPublicUrl(d: VercelDeployment): string | null {
  return toHttps(d.alias?.[0]) ?? toHttps(d.url);
}

export function createVercelAdapter(options: VercelOptions = {}): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBase ?? VERCEL_API;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deployTimeoutMs = options.deployTimeoutMs ?? DEFAULT_VERCEL_DEPLOY_TIMEOUT_MS;
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_VERCEL_HTTP_TIMEOUT_MS;

  return {
    id: "vercel",
    supports: ["frontend_static"],

    requiredCredentials() {
      return { provider: "vercel", required: ["apiToken"], optional: ["teamId"] };
    },

    async deploy(input: DeployInput): Promise<DeployResult> {
      if (input.service.type !== "frontend_static") {
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: `Vercel adapter only supports frontend_static, not "${input.service.type}".`,
        };
      }

      let token: string;
      let teamId: string | undefined;
      try {
        ({ token, teamId } = creds(input.credentials));
      } catch (e) {
        const err = deployError(e);
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: err.logs,
          failureKind: err.failureKind,
        };
      }

      const stableName = (input.resourceName ?? `shipfix-${input.service.id}`).slice(0, 52);
      input.onLog?.(`Vercel: upserting project "${stableName}"`);

      let projectId: string;
      try {
        projectId = await upsertProject(fetchImpl, base, token, teamId, httpTimeoutMs, input, stableName);
      } catch (e) {
        const err = deployError(e);
        return {
          ok: false,
          externalId: null,
          publicUrl: null,
          status: "deploy_failed",
          logs: err.logs,
          failureKind: err.failureKind,
        };
      }

      if (Object.keys(input.env).length > 0) {
        input.onLog?.(`Vercel: setting ${Object.keys(input.env).length} build env var(s)`);
        try {
          await setProjectEnv(fetchImpl, base, token, teamId, httpTimeoutMs, projectId, input.env);
        } catch (e) {
          const err = deployError(e);
          return {
            ok: false,
            externalId: projectId,
            publicUrl: null,
            status: "deploy_failed",
            logs: err.logs,
            failureKind: err.failureKind,
          };
        }
      }

      let repoId: string;
      try {
        repoId = await resolveGitRepoId(
          fetchImpl,
          base,
          token,
          teamId,
          httpTimeoutMs,
          projectId,
          input,
          input.onLog,
        );
      } catch (e) {
        const err = deployError(e);
        return {
          ok: false,
          externalId: projectId,
          publicUrl: null,
          status: statusFromFailure(err.failureKind, false, false, err.failureKind === "timeout"),
          logs: err.logs,
          failureKind: err.failureKind,
        };
      }

      input.onLog?.(`Vercel: triggering git deployment for ${projectId} (repoId ${repoId})`);
      let deployId: string;
      let createUrl: string | null;
      try {
        ({ deployId, url: createUrl } = await triggerGitDeployment(
          fetchImpl,
          base,
          token,
          teamId,
          httpTimeoutMs,
          projectId,
          stableName,
          input,
          repoId,
        ));
      } catch (e) {
        const err = deployError(e);
        return {
          ok: false,
          externalId: projectId,
          publicUrl: null,
          status: statusFromFailure(err.failureKind, false, false, err.failureKind === "timeout"),
          logs: err.logs,
          failureKind: err.failureKind,
        };
      }

      const waited = await waitForDeployment(
        fetchImpl,
        base,
        token,
        teamId,
        httpTimeoutMs,
        deployId,
        { pollIntervalMs, deployTimeoutMs },
        input.onLog,
      );

      // On timeout, the build may have finished in Vercel after our window. Do
      // one final reconcile of deployment state before declaring failure.
      let ready = waited.ok;
      let reconciled = waited.deployment;
      if (waited.timedOut) {
        try {
          reconciled = await getDeployment(fetchImpl, base, token, teamId, httpTimeoutMs, deployId);
          if (reconciled.readyState === "READY") {
            ready = true;
            input.onLog?.("Vercel: deployment reached READY after poll window");
          }
        } catch {
          /* keep timeout failure */
        }
      }

      // URL resolution decoupled from alias attach: prefer the polled/reconciled
      // deployment alias/url, then the create-time url, then the project's
      // production alias (which may attach a few seconds after READY).
      let publicUrl = deploymentPublicUrl(reconciled) ?? createUrl;
      if (!publicUrl) {
        publicUrl = await getProjectProductionUrl(fetchImpl, base, token, teamId, httpTimeoutMs, projectId);
        if (publicUrl) input.onLog?.(`Vercel: resolved production URL ${publicUrl}`);
      }

      const status: DeployResult["status"] = ready
        ? publicUrl
          ? "live"
          : "deploy_failed"
        : waited.timedOut
          ? "timeout"
          : "build_failed";

      const ok = ready && !!publicUrl;
      const failureKind: DeployFailureKind | undefined = ok
        ? undefined
        : status === "timeout"
          ? "timeout"
          : status === "build_failed"
            ? "build_failed"
            : "deploy_failed";

      return {
        ok,
        externalId: projectId,
        publicUrl,
        status,
        logs: waited.logs,
        ...(failureKind ? { failureKind } : {}),
      };
    },

    async waitForReady(externalId, credentials) {
      const { token, teamId } = creds(credentials);
      try {
        const res = await vercelApiFetch(
          fetchImpl,
          base,
          `/v9/projects/${encodeURIComponent(externalId)}`,
          token,
          teamId,
          httpTimeoutMs,
        );
        if (!res.ok) await failBody(res);
        const json = (await res.json()) as { link?: { url?: string } };
        const url = json.link?.url ?? null;
        const publicUrl = url ? (url.startsWith("http") ? url : `https://${url}`) : null;
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
      const { token, teamId } = creds(credentials);
      await setProjectEnv(fetchImpl, base, token, teamId, httpTimeoutMs, externalId, env);
    },

    async teardown(externalId, credentials) {
      const { token, teamId } = creds(credentials);
      if (!externalId) return;
      await vercelApiFetch(
        fetchImpl,
        base,
        `/v9/projects/${encodeURIComponent(externalId)}`,
        token,
        teamId,
        httpTimeoutMs,
        { method: "DELETE" },
      );
    },
  };
}
