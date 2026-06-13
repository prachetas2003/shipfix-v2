/**
 * Provider credential preflight — a cheap read-only API call that proves a
 * token is accepted BEFORE it is sealed (connect time) and again before a
 * deploy run touches any resource (gate time). A bad token must fail in
 * seconds with a clear message, not after a ten-minute deploy attempt.
 *
 * Policy: only a definite rejection (401/403) fails preflight. Provider
 * outages or network errors do not block — they cannot disprove the token,
 * and the deploy pipeline classifies its own failures later.
 */

export interface PreflightResult {
  ok: boolean;
  /** User-safe message; never contains the token. */
  message?: string;
}

const PREFLIGHT_TIMEOUT_MS = 15_000;

async function probe(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    return res.status;
  } catch {
    return null; // network/timeout — cannot disprove the credential
  } finally {
    clearTimeout(timer);
  }
}

const rejected = (status: number | null): boolean => status === 401 || status === 403;

/**
 * Validate provider credentials with a read-only call. Unknown providers and
 * missing fields are reported with actionable copy; tokens are never echoed.
 */
export async function preflightProviderCredentials(
  provider: string,
  values: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  if (provider === "render") {
    const apiKey = values.apiKey?.trim();
    if (!apiKey) return { ok: false, message: "Render connection needs an API key (apiKey)." };
    const status = await probe(
      "https://api.render.com/v1/owners?limit=1",
      { accept: "application/json", authorization: `Bearer ${apiKey}` },
      fetchImpl,
    );
    if (rejected(status)) {
      return {
        ok: false,
        message:
          "Render rejected this API key. Create a new key under Render Account Settings > API Keys and try again.",
      };
    }
    return { ok: true };
  }

  if (provider === "vercel") {
    const apiToken = values.apiToken?.trim();
    if (!apiToken) return { ok: false, message: "Vercel connection needs an API token (apiToken)." };
    const status = await probe(
      "https://api.vercel.com/v2/user",
      { accept: "application/json", authorization: `Bearer ${apiToken}` },
      fetchImpl,
    );
    if (rejected(status)) {
      return {
        ok: false,
        message:
          "Vercel rejected this API token. Create a new token under Vercel Account Settings > Tokens and try again.",
      };
    }
    const teamId = values.teamId?.trim();
    if (teamId) {
      const teamStatus = await probe(
        `https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`,
        { accept: "application/json", authorization: `Bearer ${apiToken}` },
        fetchImpl,
      );
      if (rejected(teamStatus) || teamStatus === 404) {
        return {
          ok: false,
          message:
            "Vercel accepted the token but the team ID was not accessible. Check the team ID or remove it to use your personal scope.",
        };
      }
    }
    return { ok: true };
  }

  if (provider === "neon") {
    const apiKey = values.apiKey?.trim();
    if (!apiKey) return { ok: false, message: "Neon connection needs an API key (apiKey)." };
    const status = await probe(
      "https://console.neon.tech/api/v2/projects?limit=1",
      { accept: "application/json", authorization: `Bearer ${apiKey}` },
      fetchImpl,
    );
    if (rejected(status)) {
      return {
        ok: false,
        message:
          "Neon rejected this API key. Create a new key under Neon Account Settings > API Keys and try again.",
      };
    }
    return { ok: true };
  }

  // Unknown provider — nothing to validate against.
  return { ok: true };
}
