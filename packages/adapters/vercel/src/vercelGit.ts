import type { DeployFailureKind } from "@shipfix/adapter-core";

export interface VercelProjectLink {
  type?: string;
  /** Full slug (owner/repo) when present on some API responses. */
  repo?: string;
  /** GitHub org/user — Vercel often returns org + repo separately on project.link. */
  org?: string;
  repoId?: number | string;
}

export interface VercelProjectDetails {
  id?: string;
  name?: string;
  link?: VercelProjectLink;
}

export interface GitRepoSearchEntry {
  id?: number | string;
  slug?: string;
  name?: string;
  owner?: string;
}

/** Normalize owner/repo for comparison (no URL, no .git, lowercase). */
export function normalizeRepoSlug(slug: string): string {
  return slug
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function repoSlugMatches(linkRepo: string | undefined, expected: string): boolean {
  if (!linkRepo) return false;
  return normalizeRepoSlug(linkRepo) === normalizeRepoSlug(expected);
}

export function repoSlugFromSearchEntry(entry: GitRepoSearchEntry): string | null {
  if (entry.owner && entry.slug) return `${entry.owner}/${entry.slug}`;
  if (entry.name?.includes("/")) return entry.name;
  return null;
}

export function repoSlugFromLink(link: VercelProjectLink | undefined): string | null {
  if (!link) return null;
  if (link.repo?.includes("/")) return link.repo;
  if (link.org && link.repo) return `${link.org}/${link.repo}`;
  return link.repo ?? null;
}

export function linkMatchesRepo(link: VercelProjectLink | undefined, expected: string): boolean {
  const slug = repoSlugFromLink(link);
  return slug ? repoSlugMatches(slug, expected) : false;
}

export function repoIdFromLink(link: VercelProjectLink | undefined): string | null {
  if (link?.repoId == null || link.repoId === "") return null;
  return String(link.repoId);
}

/** User-facing error when Vercel repoId cannot be resolved before deploy. */
export function formatRepoIdUnresolvedError(projectId: string, repoSlug: string): string {
  return (
    `Vercel git repoId unresolved for project ${projectId} and repo ${repoSlug}. ` +
    "Ensure the GitHub repo is connected to your Vercel account and the Vercel GitHub integration can access it, then rerun Deploy."
  );
}

export class VercelRepoIdError extends Error {
  readonly failureKind: DeployFailureKind = "setup_blocker";

  constructor(message: string) {
    super(message);
    this.name = "VercelRepoIdError";
  }
}

export function buildGitSource(repoId: string, ref: string, sha?: string): Record<string, string> {
  const gitSource: Record<string, string> = {
    type: "github",
    repoId,
    ref,
  };
  if (sha) gitSource.sha = sha;
  return gitSource;
}
