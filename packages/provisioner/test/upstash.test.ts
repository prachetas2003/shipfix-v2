import { describe, expect, it } from "vitest";
import { createUpstashProvisioner, managedSecretField, isRedisSecret, serializeNeonConnectionSecret } from "../src/index";

const redis = { id: "cache", kind: "redis" as const, mode: "provision" as const, provider: "upstash" as const, exposesEnv: "REDIS_URL", migration: "none" as const };
const creds = { provider: "upstash" as const, values: { email: "me@example.com", apiKey: "up_key" } };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof fetch,
  };
}

describe("createUpstashProvisioner", () => {
  it("creates a TLS database and seals TCP + REST access together", async () => {
    const f = fakeFetch(() =>
      Response.json({ database_id: "db-1", endpoint: "happy-cat-1.upstash.io", port: 6379, password: "p@ss", rest_token: "rest-tok" }),
    );
    const p = createUpstashProvisioner({ fetchImpl: f.fetch });
    const r = await p.provision({ resourceName: "sf-abc-cache", managed: redis, credentials: creds });

    expect(r).toMatchObject({ ok: true, externalId: "db-1", host: "happy-cat-1.upstash.io", status: "live" });
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body).toMatchObject({ database_name: "sf-abc-cache", primary_region: "us-east-1", tls: true });
    const auth = (f.calls[0]!.init!.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Basic ${Buffer.from("me@example.com:up_key").toString("base64")}`);

    const secret = r.exposed!.value;
    expect(r.exposed!.name).toBe("REDIS_URL");
    expect(isRedisSecret(secret)).toBe(true);
    expect(managedSecretField(secret, "connectionUrl")).toBe("rediss://default:p%40ss@happy-cat-1.upstash.io:6379");
    expect(managedSecretField(secret, "restUrl")).toBe("https://happy-cat-1.upstash.io");
    expect(managedSecretField(secret, "restToken")).toBe("rest-tok");
  });

  it("fails cleanly without credentials, for other kinds, and on API errors", async () => {
    const p = createUpstashProvisioner({ fetchImpl: fakeFetch(() => new Response("quota exceeded", { status: 400 })).fetch });
    expect((await p.provision({ resourceName: "x", managed: redis, credentials: { provider: "upstash", values: { apiKey: "k" } } })).ok).toBe(false);
    expect((await p.provision({ resourceName: "x", managed: { ...redis, kind: "postgres" }, credentials: creds })).logs).toContain("only provision Redis");
    const r = await p.provision({ resourceName: "x", managed: redis, credentials: creds });
    expect(r.ok).toBe(false);
    expect(r.logs).toContain("HTTP 400");
  });

  it("verifies with a REST PING", async () => {
    const f = fakeFetch((url) => (url.endsWith("/ping") ? Response.json({ result: "PONG" }) : new Response("", { status: 404 })));
    const p = createUpstashProvisioner({ fetchImpl: f.fetch });
    const secret = JSON.stringify({ url: "rediss://x", restUrl: "https://h.upstash.io", restToken: "t" });
    expect(await p.verify({ name: "REDIS_URL", value: secret })).toMatchObject({ ok: true });
    expect((f.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect((await p.verify({ name: "REDIS_URL", value: "postgres://nope" })).ok).toBe(false);
  });
});

describe("managedSecretField", () => {
  it("keeps Postgres secrets to connectionUrl (pooled)", () => {
    const secret = serializeNeonConnectionSecret({ pooled: "postgres://pooled", direct: "postgres://direct", singleUri: false });
    expect(isRedisSecret(secret)).toBe(false);
    expect(managedSecretField(secret, "connectionUrl")).toBe("postgres://pooled");
    expect(managedSecretField(secret, "restToken")).toBeNull();
  });
});
