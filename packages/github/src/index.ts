/**
 * GitHub App helpers: JWT, installation tokens, webhook signatures, SHA lookup.
 * Credentials come from env (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET).
 */

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret?: string;
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
  return { appId, privateKey, webhookSecret };
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
 * Best-effort clone token for a repo. Empty string when GitHub App is not configured
 * or the app is not installed on the repo (public clone still works).
 */
export async function resolveCloneToken(args: {
  repoFullName: string;
  installationId?: string | null;
  config?: GithubAppConfig | null;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const config = args.config === undefined ? loadGithubAppConfigFromEnv() : args.config;
  if (!config) return "";
  try {
    let installationId = args.installationId?.trim() || null;
    if (!installationId) {
      installationId = await findInstallationIdForRepo(config, args.repoFullName, {
        fetchImpl: args.fetchImpl,
      });
    }
    if (!installationId) return "";
    return await createInstallationAccessToken(config, installationId, {
      fetchImpl: args.fetchImpl,
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
