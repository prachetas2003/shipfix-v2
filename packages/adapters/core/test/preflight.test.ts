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

  it("does NOT block on provider outages (5xx) — cannot disprove the token", async () => {
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
