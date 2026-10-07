/**
 * Supabase Management API client for apps that already use a Supabase
 * project. ShipFix never creates the project; it reads the URL and API keys at
 * deploy time and injects them as env vars, and only writes to the database
 * to apply the repo's own pending migrations (see supabaseMigrate.ts).
 * Returned keys are secrets: callers must not log or persist them.
 */

export interface SupabaseProjectValues {
  projectRef: string;
  url: string;
  anonKey: string | null;
  serviceRoleKey: string | null;
}

export type SupabaseLookupResult =
  | { ok: true; values: SupabaseProjectValues }
  | { ok: false; code: "unauthorized" | "project_not_found" | "project_ambiguous" | "api_error"; message: string };

export interface SupabaseApiOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

interface ApiKeyRow {
  name?: string;
  type?: string | null;
  api_key?: string | null;
}

interface ProjectRow {
  id?: string;
  ref?: string;
  name?: string;
}

const DEFAULT_BASE = "https://api.supabase.com/v1";

async function supabaseGet(
  path: string,
  accessToken: string,
  opts: SupabaseApiOptions,
): Promise<{ status: number; body: unknown }> {
  return supabaseRequest("GET", path, accessToken, opts);
}

export async function supabaseRequest(
  method: "GET" | "POST",
  path: string,
  accessToken: string,
  opts: SupabaseApiOptions,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase ?? DEFAULT_BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return { status: 0, body: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Prefer legacy JWT keys (every supabase-js version accepts them), then the newer key types. */
export function pickSupabaseKeys(rows: ApiKeyRow[]): { anonKey: string | null; serviceRoleKey: string | null } {
  const key = (match: (r: ApiKeyRow) => boolean): string | null =>
    rows.find((r) => match(r) && typeof r.api_key === "string" && r.api_key.length > 0)?.api_key ?? null;
  return {
    anonKey: key((r) => r.name === "anon") ?? key((r) => r.type === "publishable"),
    serviceRoleKey: key((r) => r.name === "service_role") ?? key((r) => r.type === "secret"),
  };
}

function unauthorized(): SupabaseLookupResult {
  return {
    ok: false,
    code: "unauthorized",
    message: "Supabase rejected the access token. Create a new one under Supabase Account > Access Tokens and reconnect.",
  };
}

/**
 * Resolve the project (the given ref, or the account's only project) and read
 * its URL and API keys.
 */
export async function fetchSupabaseProjectValues(
  accessToken: string,
  projectRef: string | null,
  opts: SupabaseApiOptions = {},
): Promise<SupabaseLookupResult> {
  let ref = projectRef?.trim() || null;
  if (!ref) {
    const projects = await supabaseGet("/projects", accessToken, opts);
    if (projects.status === 401 || projects.status === 403) return unauthorized();
    if (projects.status !== 200 || !Array.isArray(projects.body)) {
      return { ok: false, code: "api_error", message: `Supabase project list failed (HTTP ${projects.status || "network"}).` };
    }
    const refs = (projects.body as ProjectRow[]).map((p) => p.ref ?? p.id).filter((r): r is string => Boolean(r));
    if (refs.length !== 1) {
      return {
        ok: false,
        code: refs.length === 0 ? "project_not_found" : "project_ambiguous",
        message:
          refs.length === 0
            ? "This Supabase account has no projects."
            : "This Supabase account has several projects; answer the setup question with the project ref this app uses.",
      };
    }
    ref = refs[0];
  }

  const keys = await supabaseGet(`/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`, accessToken, opts);
  if (keys.status === 401 || keys.status === 403) return unauthorized();
  if (keys.status === 404) {
    return {
      ok: false,
      code: "project_not_found",
      message: `Supabase project "${ref}" was not found in the connected account. Connect the account that owns it.`,
    };
  }
  if (keys.status !== 200 || !Array.isArray(keys.body)) {
    return { ok: false, code: "api_error", message: `Supabase API key lookup failed (HTTP ${keys.status || "network"}).` };
  }
  return { ok: true, values: { projectRef: ref, url: `https://${ref}.supabase.co`, ...pickSupabaseKeys(keys.body as ApiKeyRow[]) } };
}
