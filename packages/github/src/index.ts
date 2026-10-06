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
  opts?: { fetchImpl?: typeof fetch; repositories?: string[] },
): Promise<string> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const jwt = createGithubAppJwt(config);
  const body =
    opts?.repositories && opts.repositories.length > 0
      ? JSON.stringify({ repositories: opts.repositories })
      : undefined;
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
