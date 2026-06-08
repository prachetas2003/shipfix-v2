/** Default per-request HTTP timeout for Vercel API calls (trigger, poll, reconcile). */
export const DEFAULT_VERCEL_HTTP_TIMEOUT_MS = 120_000;

/** Default wall-clock cap for waiting on a deployment to reach a terminal state. */
export const DEFAULT_VERCEL_DEPLOY_TIMEOUT_MS = 900_000;

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export function vercelHttpTimeoutMessage(timeoutMs: number, path: string): string {
  return `Vercel API request timed out after ${timeoutMs}ms (${path})`;
}

/**
 * fetch with a hard per-request timeout. Prevents a hung Vercel API call from
 * leaving a deploy activity stuck until Temporal's activity timeout.
 */
export async function vercelApiFetch(
  fetchImpl: typeof fetch,
  base: string,
  path: string,
  token: string,
  teamId: string | undefined,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const teamSuffix = teamId
    ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`
    : "";
  const url = `${base}${path}${teamSuffix}`;
  return fetchWithTimeout(fetchImpl, url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  }, timeoutMs, path);
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  pathLabel: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(vercelHttpTimeoutMessage(timeoutMs, pathLabel));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
