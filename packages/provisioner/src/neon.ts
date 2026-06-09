import pg from "pg";
import type {
  ExposedEnv,
  ManagedProvisioner,
  ProvisionInput,
  ProvisionResult,
  ProvisionerCredentials,
  VerifyResult,
} from "./types";

const NEON_API = "https://console.neon.tech/api/v2";

interface NeonCreateResponse {
  project?: { id?: string };
  connection_uris?: Array<{ connection_uri?: string }>;
}

export interface NeonOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** Max wait for a single Neon API HTTP request (ms). */
  httpTimeoutMs?: number;
}

/** Extract a non-secret hostname from a connection string (password stays out). */
function safeHost(uri: string): string | null {
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}

function fail(externalId: string | null, logs: string): ProvisionResult {
  return { ok: false, externalId, host: null, exposed: null, status: "failed", logs };
}

function neonOrgId(values: Record<string, string>): string | null {
  return (
    values.orgId?.trim() ||
    values.org_id?.trim() ||
    values.organizationId?.trim() ||
    values.organization_id?.trim() ||
    null
  );
}

async function neonFetch(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Neon API request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real Neon (managed Postgres) provisioner using the Neon REST API. No CLI, no
 * stdout scraping. Returns the connection URI as a SECRET `exposed` env that the
 * caller seals; only the hostname is ever treated as non-secret.
 */
export function createNeonProvisioner(opts: NeonOptions = {}): ManagedProvisioner {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? NEON_API;
  const httpTimeoutMs = opts.httpTimeoutMs ?? 120_000;

  return {
    id: "neon",
    kinds: ["postgres"],
    requiredCredentials() {
      return { required: ["apiKey"] };
    },

    async provision({ resourceName, managed, credentials, onLog }: ProvisionInput): Promise<ProvisionResult> {
      if (managed.kind !== "postgres") {
        return fail(null, `Neon can only provision Postgres, not "${managed.kind}".`);
      }
      const apiKey = credentials.values.apiKey;
      if (!apiKey) return fail(null, "Missing Neon credential: apiKey.");
      const orgId = neonOrgId(credentials.values);
      onLog?.(`Neon organization ID available: ${Boolean(orgId)}`);
      if (!orgId) {
        return fail(null, "Neon organization ID is missing. Add NEON_ORG_ID and restart API/worker.");
      }

      onLog?.(`Creating Neon project "${resourceName}"`);
      let res: Response;
      try {
        res = await neonFetch(doFetch, `${base}/projects`, httpTimeoutMs, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ project: { name: resourceName, org_id: orgId } }),
        });
      } catch (e) {
        return fail(null, `Neon API request failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return fail(null, `Neon API HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as NeonCreateResponse;
      const projectId = json.project?.id ?? null;
      const uri = json.connection_uris?.[0]?.connection_uri ?? null;
      if (!projectId || !uri) {
        return fail(projectId, "Neon response did not include a project id and connection URI.");
      }

      onLog?.(`Neon project ${projectId} created.`);
      return {
        ok: true,
        externalId: projectId,
        host: safeHost(uri),
        exposed: { name: managed.exposesEnv || "DATABASE_URL", value: uri },
        status: "live",
        logs: "",
      };
    },

    async verify(exposed: ExposedEnv): Promise<VerifyResult> {
      const client = new pg.Client({
        connectionString: exposed.value,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await client.connect();
        await client.query("SELECT 1");
        return { ok: true, detail: "Connected and ran SELECT 1." };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async teardown(externalId: string, credentials: ProvisionerCredentials): Promise<void> {
      const apiKey = credentials.values.apiKey;
      if (!apiKey || !externalId) return;
      await neonFetch(doFetch, `${base}/projects/${encodeURIComponent(externalId)}`, httpTimeoutMs, {
        method: "DELETE",
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      });
    },
  };
}
