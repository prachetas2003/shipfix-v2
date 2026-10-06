import type {
  ExposedEnv,
  ManagedProvisioner,
  ProvisionInput,
  ProvisionResult,
  ProvisionerCredentials,
  VerifyResult,
} from "./types";

const UPSTASH_API = "https://api.upstash.com/v2";
const DEFAULT_REGION = "us-east-1";

/** Sealed secret for an Upstash database: TCP URL for ioredis/redis, REST pair for @upstash/redis. */
export interface UpstashRedisSecret {
  url: string;
  restUrl: string;
  restToken: string;
}

export function serializeUpstashSecret(secret: UpstashRedisSecret): string {
  return JSON.stringify(secret);
}

export function parseUpstashSecret(value: string): UpstashRedisSecret | null {
  try {
    const v = JSON.parse(value) as Partial<UpstashRedisSecret>;
    if (typeof v.url === "string" && typeof v.restUrl === "string" && typeof v.restToken === "string") {
      return { url: v.url, restUrl: v.restUrl, restToken: v.restToken };
    }
  } catch {
    /* not an Upstash secret */
  }
  return null;
}

interface UpstashDatabase {
  database_id?: string;
  endpoint?: string;
  port?: number;
  password?: string;
  rest_token?: string;
}

export interface UpstashOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  httpTimeoutMs?: number;
}

function fail(externalId: string | null, logs: string): ProvisionResult {
  return { ok: false, externalId, host: null, exposed: null, status: "failed", logs };
}

function basicAuth(values: Record<string, string>): string | null {
  const email = values.email?.trim();
  const apiKey = values.apiKey?.trim();
  if (!email || !apiKey) return null;
  return `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
}

async function timedFetch(
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
      throw new Error(`Upstash request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upstash (serverless Redis) provisioner over the Upstash Developer API. The
 * TCP URL and REST token are returned as one SECRET JSON value the caller
 * seals; only the endpoint hostname is non-secret.
 */
export function createUpstashProvisioner(opts: UpstashOptions = {}): ManagedProvisioner {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? UPSTASH_API;
  const httpTimeoutMs = opts.httpTimeoutMs ?? 60_000;

  return {
    id: "upstash",
    kinds: ["redis"],
    requiredCredentials() {
      return { required: ["email", "apiKey"], optional: ["region"] };
    },

    async provision({ resourceName, managed, credentials, onLog }: ProvisionInput): Promise<ProvisionResult> {
      if (managed.kind !== "redis") {
        return fail(null, `Upstash can only provision Redis, not "${managed.kind}".`);
      }
      const auth = basicAuth(credentials.values);
      if (!auth) return fail(null, "Missing Upstash credentials: email and apiKey.");
      const region = credentials.values.region?.trim() || DEFAULT_REGION;

      onLog?.(`Creating Upstash Redis database "${resourceName}" in ${region}`);
      let res: Response;
      try {
        res = await timedFetch(doFetch, `${base}/redis/database`, httpTimeoutMs, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
          body: JSON.stringify({ database_name: resourceName, region: "global", primary_region: region, tls: true }),
        });
      } catch (e) {
        return fail(null, `Upstash API request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return fail(null, `Upstash API HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const db = (await res.json()) as UpstashDatabase;
      const id = db.database_id ?? null;
      if (!id || !db.endpoint || !db.password || !db.rest_token) {
        return fail(id, "Upstash response did not include a database id, endpoint, password and REST token.");
      }
      const port = db.port ?? 6379;
      onLog?.(`Upstash database ${id} created.`);
      return {
        ok: true,
        externalId: id,
        host: db.endpoint,
        exposed: {
          name: managed.exposesEnv || "REDIS_URL",
          value: serializeUpstashSecret({
            url: `rediss://default:${encodeURIComponent(db.password)}@${db.endpoint}:${port}`,
            restUrl: `https://${db.endpoint}`,
            restToken: db.rest_token,
          }),
        },
        status: "live",
        logs: "",
      };
    },

    async verify(exposed: ExposedEnv): Promise<VerifyResult> {
      const secret = parseUpstashSecret(exposed.value);
      if (!secret) return { ok: false, detail: "Stored Redis secret is not an Upstash connection." };
      try {
        const res = await timedFetch(doFetch, `${secret.restUrl}/ping`, 15_000, {
          headers: { authorization: `Bearer ${secret.restToken}` },
        });
        const body = (await res.json().catch(() => ({}))) as { result?: string };
        if (res.ok && body.result === "PONG") return { ok: true, detail: "Connected and got PONG." };
        return { ok: false, detail: `Redis PING returned HTTP ${res.status}.` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },

    async teardown(externalId: string, credentials: ProvisionerCredentials): Promise<void> {
      const auth = basicAuth(credentials.values);
      if (!auth || !externalId) return;
      await timedFetch(doFetch, `${base}/redis/database/${encodeURIComponent(externalId)}`, httpTimeoutMs, {
        method: "DELETE",
        headers: { accept: "application/json", authorization: auth },
      });
    },
  };
}
