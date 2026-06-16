import { readVercelBody, failVercelBody, parseVercelJson } from "./vercelHttp.js";
import { vercelApiFetch } from "./vercelFetch.js";

export const DEFAULT_VERCEL_ENV_TARGETS = ["production", "preview"] as const;

export interface VercelEnvVar {
  id: string;
  key: string;
  target?: string[];
  gitBranch?: string | null;
}

export function targetsMatch(existing: string[] | undefined, desired: readonly string[]): boolean {
  const want = new Set(desired);
  const have = new Set(existing ?? []);
  if (want.size !== have.size) return false;
  for (const t of want) {
    if (!have.has(t)) return false;
  }
  return true;
}

export function branchMatches(existing: string | null | undefined, desired?: string): boolean {
  return (existing ?? undefined) === (desired ?? undefined);
}

export function envVarMatches(
  existing: VercelEnvVar,
  key: string,
  targets: readonly string[],
  gitBranch?: string,
): boolean {
  return (
    existing.key === key &&
    targetsMatch(existing.target, targets) &&
    branchMatches(existing.gitBranch, gitBranch)
  );
}

export function isDuplicateEnvVarError(bodyText: string): boolean {
  return /variable with the name .* already exists/i.test(bodyText) || /already exists for the target/i.test(bodyText);
}

async function listProjectEnvVars(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
): Promise<VercelEnvVar[]> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v10/projects/${encodeURIComponent(projectId)}/env`,
    token,
    teamId,
    httpTimeoutMs,
  );
  if (!res.ok) await failVercelBody(res, "list env vars");
  const json = await parseVercelJson<{ envs?: VercelEnvVar[] }>(res, "list env vars");
  return json.envs ?? [];
}

async function deleteProjectEnvVar(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  envId: string,
): Promise<void> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v10/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
    token,
    teamId,
    httpTimeoutMs,
    { method: "DELETE" },
  );
  if (!res.ok) await failVercelBody(res, "delete env var");
}

async function createProjectEnvVar(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  key: string,
  value: string,
  targets: readonly string[],
  gitBranch?: string,
): Promise<Response> {
  return vercelApiFetch(
    fetchImpl,
    base,
    `/v10/projects/${encodeURIComponent(projectId)}/env`,
    token,
    teamId,
    httpTimeoutMs,
    {
      method: "POST",
      body: JSON.stringify({
        key,
        value,
        type: "plain",
        target: [...targets],
        ...(gitBranch ? { gitBranch } : {}),
      }),
    },
  );
}

export class VercelEnvConflictError extends Error {
  readonly failureKind = "provider_env_conflict" as const;

  constructor(key: string, detail: string) {
    super(`Vercel env var conflict for ${key}: ${detail}`);
    this.name = "VercelEnvConflictError";
  }
}

/**
 * Upsert one project env var: list existing, delete matching key/target/branch,
 * create with desired value. Retries once on duplicate HTTP 400.
 */
export async function upsertProjectEnvVar(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  key: string,
  value: string,
  onLog?: (line: string) => void,
  gitBranch?: string,
  targets: readonly string[] = DEFAULT_VERCEL_ENV_TARGETS,
): Promise<void> {
  const ctx = { fetchImpl, base, token, teamId, httpTimeoutMs, projectId };

  const removeMatching = async (): Promise<boolean> => {
    const existing = await listProjectEnvVars(
      ctx.fetchImpl,
      ctx.base,
      ctx.token,
      ctx.teamId,
      ctx.httpTimeoutMs,
      ctx.projectId,
    );
    const match = existing.find((row) => envVarMatches(row, key, targets, gitBranch));
    if (!match) return false;
    onLog?.(`Vercel: env var exists, replacing ${key}`);
    await deleteProjectEnvVar(
      ctx.fetchImpl,
      ctx.base,
      ctx.token,
      ctx.teamId,
      ctx.httpTimeoutMs,
      ctx.projectId,
      match.id,
    );
    return true;
  };

  await removeMatching();

  const attemptCreate = async (): Promise<Response> =>
    createProjectEnvVar(
      ctx.fetchImpl,
      ctx.base,
      ctx.token,
      ctx.teamId,
      ctx.httpTimeoutMs,
      ctx.projectId,
      key,
      value,
      targets,
      gitBranch,
    );

  let res = await attemptCreate();
  if (!res.ok) {
    const bodyText = await readVercelBody(res);
    if (res.status === 400 && isDuplicateEnvVarError(bodyText)) {
      await removeMatching();
      res = await attemptCreate();
      if (!res.ok) {
        const retryBody = await readVercelBody(res);
        if (res.status === 400 && isDuplicateEnvVarError(retryBody)) {
          throw new VercelEnvConflictError(
            key,
            "ShipFix could not replace the env var after listing and deleting the conflicting entry.",
          );
        }
        await failVercelBody(
          new Response(retryBody, { status: res.status, statusText: res.statusText }),
          "create env var",
        );
      }
    } else {
      await failVercelBody(new Response(bodyText, { status: res.status, statusText: res.statusText }), "create env var");
    }
  }

  onLog?.(`Vercel: env var ${key} updated`);
}

export async function setProjectEnv(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  env: Record<string, string>,
  onLog?: (line: string) => void,
): Promise<void> {
  for (const [key, value] of Object.entries(env)) {
    await upsertProjectEnvVar(fetchImpl, base, token, teamId, httpTimeoutMs, projectId, key, value, onLog);
  }
}
