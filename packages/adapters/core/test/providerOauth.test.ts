import { describe, expect, it } from "vitest";
import {
  allowedOauthRedirect,
  authorizeUrl,
  credentialValues,
  exchangeOauthCode,
  loadOauthApps,
  refreshOAuthCredentials,
  signOauthState,
  verifyOauthState,
  type OauthApp,
} from "../src/providerOauth";

const neon: OauthApp = { provider: "neon", clientId: "neon-id", clientSecret: "neon-secret" };
const vercel: OauthApp = { provider: "vercel", clientId: "vc-id", clientSecret: "vc-secret", slug: "shipfix" };

describe("provider oauth", () => {
  it("loads only providers whose secrets are set, and Vercel needs a slug", () => {
    const apps = loadOauthApps({
      NEON_OAUTH_CLIENT_ID: "n",
      NEON_OAUTH_CLIENT_SECRET: "s",
      VERCEL_OAUTH_CLIENT_ID: "v",
      VERCEL_OAUTH_CLIENT_SECRET: "s",
      SUPABASE_OAUTH_CLIENT_ID: "only-id",
    });
    expect(apps.map((app) => app.provider)).toEqual(["neon"]);
  });

  it("builds the Neon authorize URL with PKCE and refuses a foreign redirect", () => {
    expect(allowedOauthRedirect("http://localhost:3000/providers/callback", "*")).toBe(true);
    expect(allowedOauthRedirect("https://evil.example/providers/callback", "*")).toBe(false);
    expect(allowedOauthRedirect("https://app.shipfix.dev/providers/callback", "https://app.shipfix.dev")).toBe(true);
    const url = new URL(authorizeUrl(neon, { redirectUri: "http://localhost:3000/providers/callback", state: "st", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://oauth2.neon.tech/oauth2/auth");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("scope")).toContain("urn:neoncloud:projects:create");
  });

  it("stores a Vercel integration token as apiToken and a team id", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "tok", team_id: "team_1" }), { status: 200 })) as typeof fetch;
    const values = await exchangeOauthCode(vercel, {
      code: "code",
      redirectUri: "http://localhost:3000/providers/callback",
      fetchImpl,
    });
    expect(values).toEqual({ apiToken: "tok", teamId: "team_1" });
    expect(authorizeUrl(vercel, { redirectUri: "http://localhost:3000/providers/callback", state: "st" })).toContain(
      "https://vercel.com/integrations/shipfix/new",
    );
  });

  it("refreshes an expired Supabase token and keeps the refresh token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })) as typeof fetch;
    const out = await refreshOAuthCredentials(
      "supabase",
      { accessToken: "old", refreshToken: "refresh", expiresAt: "1" },
      {
        now: 10_000,
        env: { SUPABASE_OAUTH_CLIENT_ID: "id", SUPABASE_OAUTH_CLIENT_SECRET: "secret" },
        fetchImpl,
      },
    );
    expect(out.rotated).toBe(true);
    expect(out.values.accessToken).toBe("new");
    expect(out.values.refreshToken).toBe("refresh");
    expect(credentialValues("supabase", { access_token: "a" }, 0).refreshToken).toBeUndefined();
  });

  it("rejects a state signed for a different user", () => {
    const state = signOauthState("secret", { userId: "user-1", provider: "neon", exp: 5_000 });
    expect(verifyOauthState("secret", state, { userId: "user-1", provider: "neon" }, 1_000)?.provider).toBe("neon");
    expect(verifyOauthState("secret", state, { userId: "user-2", provider: "neon" }, 1_000)).toBeNull();
    expect(verifyOauthState("other", state, { userId: "user-1", provider: "neon" }, 1_000)).toBeNull();
    expect(verifyOauthState("secret", state, { userId: "user-1", provider: "neon" }, 9_000)).toBeNull();
  });
});
