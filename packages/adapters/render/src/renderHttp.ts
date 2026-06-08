import { redact } from "@shipfix/secrets";

export type ParseRenderOptions = {
  /** When true, HTTP 2xx with an empty body returns null instead of throwing. */
  allowEmptyOk?: boolean;
};

/**
 * Read a Render API response safely: text first, then JSON when non-empty.
 * Never surfaces raw `JSON.parse` errors to callers.
 */
export async function parseRenderResponse(
  res: Response,
  action: string,
  options: ParseRenderOptions = {},
): Promise<unknown | null> {
  const text = await res.text().catch(() => "");

  if (!text.trim()) {
    if (!res.ok) {
      throw renderApiError(action, res, text);
    }
    if (options.allowEmptyOk) {
      return null;
    }
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw renderApiError(action, res, text);
  }
}

/** Redacted adapter error for failed Render HTTP calls and invalid JSON bodies. */
export function renderApiError(action: string, res: Response, bodyText: string): Error {
  const status = `${res.status} ${res.statusText}`.trim();
  const preview = redact(bodyText).trim().slice(0, 500);
  const detail = preview.length > 0 ? preview : "(empty body)";
  return new Error(`Render API ${action} failed (HTTP ${status}): ${detail}`);
}

/** User-facing deploy failure detail (no secrets). */
export function formatDeployFailureDetail(opts: {
  serviceId: string;
  deployId?: string | null;
  action: string;
  status?: string | null;
  extra?: string;
}): string {
  const parts = [
    `Render ${opts.action} failed`,
    `service ${opts.serviceId}`,
    opts.deployId ? `deploy ${opts.deployId}` : null,
    opts.status ? `status ${opts.status}` : null,
    opts.extra,
    "Check the Render dashboard build logs for this service.",
  ].filter((p): p is string => Boolean(p));
  return parts.join("; ");
}
