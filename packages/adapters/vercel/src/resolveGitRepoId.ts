import type { DeployInput } from "@shipfix/adapter-core";
import {
  formatRepoIdUnresolvedError,
  linkMatchesRepo,
  repoIdFromLink,
  repoSlugFromSearchEntry,
  repoSlugMatches,
  type GitRepoSearchEntry,
  type VercelProjectDetails,
  VercelRepoIdError,
} from "./vercelGit.js";
import { failVercelBody, parseVercelJson } from "./vercelHttp.js";
import { vercelApiFetch } from "./vercelFetch.js";

type FetchImpl = typeof fetch;

async function failBody(res: Response, action: string): Promise<never> {
  return failVercelBody(res, action);
}

export async function getProjectDetails(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
): Promise<VercelProjectDetails> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v9/projects/${encodeURIComponent(projectId)}`,
    token,
    teamId,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res, "get project");
  return parseVercelJson<VercelProjectDetails>(res, "get project");
}

/** Link a GitHub repo to an existing project (create-only gitRepository is not valid on PATCH). */
async function linkProjectGitRepository(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  repoSlug: string,
): Promise<VercelProjectDetails> {
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v9/projects/${encodeURIComponent(projectId)}/link`,
    token,
    teamId,
    httpTimeoutMs,
    {
      method: "POST",
      body: JSON.stringify({ type: "github", repo: repoSlug }),
    },
  );
  if (!res.ok) await failBody(res, "link project git repository");
  return parseVercelJson<VercelProjectDetails>(res, "link project git repository");
}

async function searchGitRepoId(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  repoSlug: string,
): Promise<string | null> {
  const qs = new URLSearchParams({ provider: "github", query: repoSlug });
  const res = await vercelApiFetch(
    fetchImpl,
    base,
    `/v1/integrations/search-repo?${qs}`,
    token,
    teamId,
    httpTimeoutMs,
  );
  if (!res.ok) await failBody(res, "search git repository");
  const json = await parseVercelJson<{ repos?: GitRepoSearchEntry[] }>(res, "search git repository");
  for (const entry of json.repos ?? []) {
    const candidate = repoSlugFromSearchEntry(entry);
    if (candidate && repoSlugMatches(candidate, repoSlug) && entry.id != null) {
      return String(entry.id);
    }
  }
  return null;
}

function repoIdFromProject(project: VercelProjectDetails, repoSlug: string): string | null {
  const linkId = repoIdFromLink(project.link);
  if (linkId && linkMatchesRepo(project.link, repoSlug)) return linkId;
  return null;
}

/**
 * Resolve Vercel's GitHub repoId for a repo slug: project link first, POST /link, then search-repo.
 */
export async function resolveGitRepoId(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  teamId: string | undefined,
  httpTimeoutMs: number,
  projectId: string,
  input: DeployInput,
  onLog?: (line: string) => void,
): Promise<string> {
  const repoSlug = input.repo.fullName;

  let project = await getProjectDetails(fetchImpl, base, token, teamId, httpTimeoutMs, projectId);
  let linkId = repoIdFromProject(project, repoSlug);
  if (linkId) {
    onLog?.(`Vercel: using git repoId ${linkId} from project link`);
    return linkId;
  }

  if (!linkMatchesRepo(project.link, repoSlug)) {
    onLog?.(`Vercel: linking project ${projectId} to ${repoSlug}`);
    project = await linkProjectGitRepository(fetchImpl, base, token, teamId, httpTimeoutMs, projectId, repoSlug);
    linkId = repoIdFromProject(project, repoSlug);
    if (linkId) {
      onLog?.(`Vercel: using git repoId ${linkId} after project link`);
      return linkId;
    }
    project = await getProjectDetails(fetchImpl, base, token, teamId, httpTimeoutMs, projectId);
    linkId = repoIdFromProject(project, repoSlug);
    if (linkId) {
      onLog?.(`Vercel: using git repoId ${linkId} from project link`);
      return linkId;
    }
  }

  onLog?.(`Vercel: searching linked GitHub repos for ${repoSlug}`);
  const searched = await searchGitRepoId(fetchImpl, base, token, teamId, httpTimeoutMs, repoSlug);
  if (searched) {
    onLog?.(`Vercel: using git repoId ${searched} from integrations search`);
    return searched;
  }

  throw new VercelRepoIdError(formatRepoIdUnresolvedError(projectId, repoSlug));
}
