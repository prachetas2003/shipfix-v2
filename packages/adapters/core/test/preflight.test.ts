import { describe, expect, it } from "vitest";
import { preflightProviderCredentials } from "../src/preflight";

function fetchWithStatus(status: number, capture?: { urls: string[]; auth: string[] }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.urls.push(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    capture?.auth.push(headers.authorization ?? "");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
}

describe("preflightProviderCredentials", () => {
  it("accepts a Render key the API accepts", async () => {
    const r = await preflightProviderCredentials("render", { apiKey: "rnd_ok" }, fetchWithStatus(200));
    expect(r.ok).toBe(true);
  });

  it("rejects a Render key the API rejects, without echoing the token", async () => {
    const r = await preflightProviderCredentials("render", { apiKey: "rnd_bad" }, fetchWithStatus(401));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Render rejected");
    expect(r.message).not.toContain("rnd_bad");
  });

  it("rejects a Vercel token on 403", async () => {
    const r = await preflightProviderCredentials("vercel", { apiToken: "vc_bad" }, fetchWithStatus(403));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Vercel rejected");
  });

  it("checks the Vercel team when a teamId is supplied", async () => {
    const capture = { urls: [] as string[], auth: [] as string[] };
    const r = await preflightProviderCredentials(
      "vercel",
      { apiToken: "vc_ok", teamId: "team_123" },
      fetchWithStatus(200, capture),
    );
    expect(r.ok).toBe(true);
    expect(capture.urls.some((u) => u.includes("/v2/teams/team_123"))).toBe(true);
  });

  it("rejects a Neon key on 401", async () => {
    const r = await preflightProviderCredentials("neon", { apiKey: "neon_bad" }, fetchWithStatus(401));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Neon rejected");
  });

  it("fails fast when the required field is missing", async () => {
    const r = await preflightProviderCredentials("render", {}, fetchWithStatus(200));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("API key");
  });

  it("does NOT block on provider outages (5xx) â€” cannot disprove the token", async () => {
    const r = await preflightProviderCredentials("render", { apiKey: "rnd_ok" }, fetchWithStatus(503));
    expect(r.ok).toBe(true);
  });

  it("does NOT block on network errors", async () => {
    const failingFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await preflightProviderCredentials("vercel", { apiToken: "vc_ok" }, failingFetch);
    expect(r.ok).toBe(true);
  });

  it("passes through unknown providers", async () => {
    const r = await preflightProviderCredentials("somethingelse", { token: "x" }, fetchWithStatus(401));
    expect(r.ok).toBe(true);
  });
});

describe("preflightProviderCredentials — supabase", () => {
  it("checks a Supabase access token against the Management API", async () => {
    const capture = { urls: [] as string[], auth: [] as string[] };
    const ok = await preflightProviderCredentials("supabase", { accessToken: "sbp_ok" }, fetchWithStatus(200, capture));
    expect(ok.ok).toBe(true);
    expect(capture.urls[0]).toBe("https://api.supabase.com/v1/projects");
    const bad = await preflightProviderCredentials("supabase", { accessToken: "sbp_bad" }, fetchWithStatus(401));
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toContain("sbp_bad");
    expect((await preflightProviderCredentials("supabase", {}, fetchWithStatus(200))).ok).toBe(false);
  });
});

describe("preflightProviderCredentials — upstash", () => {
  it("needs email + API key and checks them with basic auth", async () => {
    const capture = { urls: [] as string[], auth: [] as string[] };
    const ok = await preflightProviderCredentials("upstash", { email: "me@x.io", apiKey: "up_ok" }, fetchWithStatus(200, capture));
    expect(ok.ok).toBe(true);
    expect(capture.auth[0]).toBe(`Basic ${Buffer.from("me@x.io:up_ok").toString("base64")}`);
    const bad = await preflightProviderCredentials("upstash", { email: "me@x.io", apiKey: "up_bad" }, fetchWithStatus(401));
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toContain("up_bad");
    expect((await preflightProviderCredentials("upstash", { apiKey: "k" }, fetchWithStatus(200))).ok).toBe(false);
  });
});
