/**
 * GitHub App helpers: JWT, installation tokens, webhook signatures, SHA lookup.
 * Credentials come from env (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET).
 */

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret?: string;
  /** OAuth client credentials of the App, used to prove which user owns an installation. */
  clientId?: string;
  clientSecret?: string;
  /** Public slug, for building the install URL (https://github.com/apps/<slug>/installations/new). */
  slug?: string;
}

/** Load GitHub App config from process.env. Returns null when unset (public-only mode). */
export function loadGithubAppConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  let privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return null;
  // Support base64-encoded PEMs and escaped newlines from .env files.
  if (!privateKey.includes("BEGIN")) {
    try {
      privateKey = Buffer.from(privateKey, "base64").toString("utf8");
    } catch {
      /* keep as-is */
    }
  }
  privateKey = privateKey.replace(/\\n/g, "\n");
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim() || undefined;
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() || undefined;
  const slug = env.GITHUB_APP_SLUG?.trim() || undefined;
  return { appId, privateKey, webhookSecret, clientId, clientSecret, slug };
}

export function githubAppInstallUrl(config: GithubAppConfig | null, state?: string): string | null {
  if (!config?.slug) return null;
  const qs = state ? `?state=${encodeURIComponent(state)}` : "";
  return `https://github.com/apps/${config.slug}/installations/new${qs}`;
}

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "shipfix",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Exchange a GitHub App user-authorization `code` for a user-to-server token. */
export async function exchangeGithubUserCode(
  config: GithubAppConfig,
  code: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<string> {
  if (!config.clientId || !config.clientSecret) {
    throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required to verify installations.");
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "shipfix" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  if (!res.ok) throw new Error(`GitHub OAuth exchange failed (${res.status}).`);
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`GitHub OAuth exchange failed (${json.error ?? "no token"}).`);
  return json.access_token;
}

export interface GithubUserInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** Installations of this App the authenticated user can access (admin or member). */
export async function listGithubUserInstallations(
  userToken: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<GithubUserInstallation[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const out: GithubUserInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) throw new Error(`Listing GitHub installations failed (${res.status}).`);
    const json = (await res.json()) as {
      installations?: Array<{ id: number; account?: { login?: string; type?: string } }>;
    };
    const batch = json.installations ?? [];
    for (const inst of batch) {
      out.push({
        installationId: String(inst.id),
        accountLogin: inst.account?.login ?? "",
        accountType: inst.account?.type ?? "User",
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** The repo's real default branch (never assume "main"). */
export async function resolveGithubDefaultBranch(
  repoFullName: string,
  opts?: { token?: string | null; fetchImpl?: typeof fetch },
): Promise<{ branch: string } | { error: string; message: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoFullName}`, {
      headers: { ...GITHUB_HEADERS, ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    });
    if (res.status === 404) {
      return {
        error: "repo_not_found",
        message: `Could not find ${repoFullName} on GitHub. Check the name, or install the ShipFix GitHub App for private repos.`,
      };
    }
    if (!res.ok) {
      return { error: "github_lookup_failed", message: `GitHub returned ${res.status} while looking up ${repoFullName}.` };
    }
    const json = (await res.json()) as { default_branch?: string };
    const branch = json.default_branch?.trim();
    if (!branch) return { error: "github_lookup_failed", message: "GitHub did not return a default branch." };
    return { branch };
  } catch {
    return { error: "github_lookup_failed", message: "Could not reach GitHub to look up the repository." };
  }
}

export function createGithubAppJwt(config: GithubAppConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: config.appId,
  };
  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(config.privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

export async function createInstallationAccessToken(
  config: GithubAppConfig,
  installationId: string | number,
  opts?: { fetchImpl?: typeof fetch; repositories?: string[]; permissions?: Record<string, "read" | "write"> },
): Promise<string> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const jwt = createGithubAppJwt(config);
  const scoped = {
    ...(opts?.repositories && opts.repositories.length > 0 ? { repositories: opts.repositories } : {}),
    ...(opts?.permissions ? { permissions: opts.permissions } : {}),
  };
  const body = Object.keys(scoped).length > 0 ? JSON.stringify(scoped) : undefined;
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "shipfix",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub installation token failed (${res.status}).`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("GitHub installation token response missing token.");
  return json.token;
}

export interface InstallationRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** Repos the installation can see. One page is enough for the picker. */
export async function listInstallationRepositories(
  token: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<InstallationRepo[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.github.com/installation/repositories?per_page=100", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "shipfix",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub repository list failed (${res.status}).`);
  const json = (await res.json()) as {
    repositories?: Array<{ full_name?: string; private?: boolean; default_branch?: string }>;
  };
  return (json.repositories ?? [])
    .filter((repo): repo is { full_name: string; private?: boolean; default_branch?: string } => Boolean(repo.full_name))
    .map((repo) => ({
      fullName: repo.full_name,
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch || "main",
    }));
}

/** Resolve the installation that covers a repo (requires the app to be installed). */
export async function findInstallationIdForRepo(
  config: GithubAppConfig,
  repoFullName: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const jwt = createGithubAppJwt(config);
  const res = await fetchImpl(`https://api.github.com/repos/${repoFullName}/installation`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "shipfix",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: number };
  return json.id != null ? String(json.id) : null;
}

/**
 * Best-effort clone token for a repo, scoped to the requesting tenant. Only
 * installations in `allowedInstallationIds` (the ones the project owner has proven
 * they control) are ever used, so one user can never clone through another user's
 * installation. Empty string means "clone anonymously" (public repos still work).
 */
export async function resolveCloneToken(args: {
  repoFullName: string;
  installationId?: string | null;
  allowedInstallationIds: readonly string[];
  config?: GithubAppConfig | null;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const config = args.config === undefined ? loadGithubAppConfigFromEnv() : args.config;
  if (!config || args.allowedInstallationIds.length === 0) return "";
  const allowed = new Set(args.allowedInstallationIds);
  try {
    let installationId = args.installationId?.trim() || null;
    if (installationId && !allowed.has(installationId)) installationId = null;
    if (!installationId) {
      const found = await findInstallationIdForRepo(config, args.repoFullName, {
        fetchImpl: args.fetchImpl,
      });
      installationId = found && allowed.has(found) ? found : null;
    }
    if (!installationId) return "";
    const repoName = args.repoFullName.split("/")[1];
    return await createInstallationAccessToken(config, installationId, {
      fetchImpl: args.fetchImpl,
      repositories: repoName ? [repoName] : undefined,
    });
  } catch {
    return "";
  }
}

/**
 * Token that can push branches to one repo, under the same tenant rules as
 * {@link resolveCloneToken}. Null when the App isn't configured, isn't
 * installed for the repo, or wasn't granted write access to contents.
 */
export async function resolveRepoWriteToken(args: {
  repoFullName: string;
  installationId?: string | null;
  allowedInstallationIds: readonly string[];
  permissions?: Record<string, "read" | "write">;
  config?: GithubAppConfig | null;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const config = args.config === undefined ? loadGithubAppConfigFromEnv() : args.config;
  if (!config || args.allowedInstallationIds.length === 0) return null;
  const allowed = new Set(args.allowedInstallationIds);
  try {
    let installationId = args.installationId?.trim() || null;
    if (installationId && !allowed.has(installationId)) installationId = null;
    if (!installationId) {
      const found = await findInstallationIdForRepo(config, args.repoFullName, { fetchImpl: args.fetchImpl });
      installationId = found && allowed.has(found) ? found : null;
    }
    if (!installationId) return null;
    const repoName = args.repoFullName.split("/")[1];
    return await createInstallationAccessToken(config, installationId, {
      fetchImpl: args.fetchImpl,
      repositories: repoName ? [repoName] : undefined,
      permissions: args.permissions ?? { contents: "write" },
    });
  } catch {
    return null;
  }
}

export interface CommitFileChange {
  path: string;
  /** New content; null deletes the file. */
  content: string | null;
}

async function githubJson<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const res = await fetchImpl(`https://api.github.com${url}`, {
    method,
    headers: {
      ...GITHUB_HEADERS,
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Commit file changes on top of `baseSha` and point `branch` at the result
 * (created, or force-moved when ShipFix already owns it). No clone needed.
 */
export async function pushCommitToBranch(args: {
  token: string;
  repoFullName: string;
  baseSha: string;
  branch: string;
  message: string;
  changes: CommitFileChange[];
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; sha: string; url: string } | { ok: false; error: string }> {
  const f = args.fetchImpl ?? fetch;
  const repo = `/repos/${args.repoFullName}`;
  const fail = (step: string, status: number) => ({ ok: false as const, error: `GitHub ${step} failed (${status}).` });

  const base = await githubJson<{ tree?: { sha?: string } }>(f, args.token, "GET", `${repo}/git/commits/${args.baseSha}`);
  const baseTree = base.json?.tree?.sha;
  if (base.status !== 200 || !baseTree) return fail("reading the base commit", base.status);

  const tree = await githubJson<{ sha?: string }>(f, args.token, "POST", `${repo}/git/trees`, {
    base_tree: baseTree,
    tree: args.changes.map((c) =>
      c.content === null
        ? { path: c.path, mode: "100644", type: "blob", sha: null }
        : { path: c.path, mode: "100644", type: "blob", content: c.content },
    ),
  });
  if (tree.status !== 201 || !tree.json?.sha) return fail("creating the tree", tree.status);

  const commit = await githubJson<{ sha?: string }>(f, args.token, "POST", `${repo}/git/commits`, {
    message: args.message,
    tree: tree.json.sha,
    parents: [args.baseSha],
  });
  const sha = commit.json?.sha;
  if (commit.status !== 201 || !sha) return fail("creating the commit", commit.status);

  const ref = `refs/heads/${args.branch}`;
  const created = await githubJson(f, args.token, "POST", `${repo}/git/refs`, { ref, sha });
  if (created.status !== 201) {
    if (created.status !== 422) return fail("creating the branch", created.status);
    const moved = await githubJson(f, args.token, "PATCH", `${repo}/git/${ref}`, { sha, force: true });
    if (moved.status !== 200) return fail("updating the branch", moved.status);
  }
  return { ok: true, sha, url: `https://github.com/${args.repoFullName}/tree/${encodeURIComponent(args.branch)}` };
}

/**
 * Open a pull request from `head` into `base`, or refresh the title/body of the
 * one already open for that branch (repeat repairs on a run share one PR).
 */
export async function openOrUpdatePullRequest(args: {
  token: string;
  repoFullName: string;
  head: string;
  base: string;
  title: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; number: number; url: string; created: boolean } | { ok: false; error: string }> {
  const f = args.fetchImpl ?? fetch;
  const repo = `/repos/${args.repoFullName}`;
  const owner = args.repoFullName.split("/")[0] ?? "";

  const open = await githubJson<Array<{ number?: number; html_url?: string }>>(
    f,
    args.token,
    "GET",
    `${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.head}`)}&per_page=1`,
  );
  if (open.status !== 200) return { ok: false, error: `GitHub listing pull requests failed (${open.status}).` };
  const existing = open.json?.[0];
  if (existing?.number) {
    const upd = await githubJson<{ html_url?: string }>(f, args.token, "PATCH", `${repo}/pulls/${existing.number}`, {
      title: args.title,
      body: args.body,
    });
    if (upd.status !== 200) return { ok: false, error: `GitHub updating the pull request failed (${upd.status}).` };
    return { ok: true, number: existing.number, url: upd.json?.html_url ?? existing.html_url ?? "", created: false };
  }

  const created = await githubJson<{ number?: number; html_url?: string }>(f, args.token, "POST", `${repo}/pulls`, {
    title: args.title,
    body: args.body,
    head: args.head,
    base: args.base,
    maintainer_can_modify: true,
  });
  if (created.status !== 201 || !created.json?.number) {
    return { ok: false, error: `GitHub opening the pull request failed (${created.status}).` };
  }
  return { ok: true, number: created.json.number, url: created.json.html_url ?? "", created: true };
}

export function verifyGithubWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function resolveGithubBranchSha(
  repoFullName: string,
  branch: string,
  opts?: { token?: string | null; fetchImpl?: typeof fetch },
): Promise<{ sha: string } | { error: string; message: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const endpoint = `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(branch)}`;
  try {
    const res = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "shipfix",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
    });
    if (res.status === 404) {
      return {
        error: "repo_or_branch_not_found",
        message: `Could not find ${repoFullName}@${branch} on GitHub. Confirm the repo exists, the default branch is correct, and the ShipFix GitHub App is installed for private repos.`,
      };
    }
    if (!res.ok) {
      return {
        error: "github_lookup_failed",
        message: `GitHub returned ${res.status} while resolving the latest commit. Try again in a minute.`,
      };
    }
    const json = (await res.json()) as { sha?: string };
    if (!json.sha || !/^[0-9a-f]{7,40}$/i.test(json.sha)) {
      return {
        error: "github_lookup_failed",
        message: "GitHub did not return a commit SHA for this branch.",
      };
    }
    return { sha: json.sha };
  } catch {
    return {
      error: "github_lookup_failed",
      message: "Could not reach GitHub to resolve the latest commit.",
    };
  }
}

export interface GithubPushEvent {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  installation?: { id?: number };
}

/** True when this push should trigger auto-deploy for the project's default branch. */
export function shouldAutoDeployPush(
  event: GithubPushEvent,
  defaultBranch: string,
): { ok: true; commitSha: string; repoFullName: string; installationId: string | null } | { ok: false; reason: string } {
  if (event.deleted) return { ok: false, reason: "branch_deleted" };
  const repoFullName = event.repository?.full_name?.trim();
  if (!repoFullName) return { ok: false, reason: "missing_repo" };
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (event.ref !== expectedRef) return { ok: false, reason: "wrong_branch" };
  const commitSha = event.after?.trim() ?? "";
  if (!/^[0-9a-f]{7,40}$/i.test(commitSha) || /^0+$/.test(commitSha)) {
    return { ok: false, reason: "invalid_sha" };
  }
  return {
    ok: true,
    commitSha,
    repoFullName,
    installationId: event.installation?.id != null ? String(event.installation.id) : null,
  };
}
