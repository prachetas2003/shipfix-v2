import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Providers whose OAuth token can be stored as the credential the adapters already use. */
export const OAUTH_PROVIDERS = ["vercel", "neon", "supabase"] as const;
export type OauthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface OauthApp {
  provider: OauthProvider;
  clientId: string;
  clientSecret: string;
  /** Vercel integration slug. The install URL is built from it. */
  slug?: string;
}

export interface OauthToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  team_id?: string | null;
}

const NEON_SCOPES = [
  "urn:neoncloud:projects:create",
  "urn:neoncloud:projects:read",
  "urn:neoncloud:projects:update",
  "urn:neoncloud:projects:delete",
  "urn:neoncloud:orgs:read",
].join(" ");

function envName(provider: OauthProvider, part: "CLIENT_ID" | "CLIENT_SECRET"): string {
  return `${provider.toUpperCase()}_OAUTH_${part}`;
}

export function isOauthProvider(provider: string): provider is OauthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(provider);
}

/** Apps whose client id and secret are set. Vercel also needs the integration slug. */
export function loadOauthApps(env: NodeJS.ProcessEnv = process.env): OauthApp[] {
  return OAUTH_PROVIDERS.flatMap((provider) => {
    const app = loadOauthApp(provider, env);
    return app ? [app] : [];
  });
}

export function loadOauthApp(provider: string, env: NodeJS.ProcessEnv = process.env): OauthApp | null {
  if (!isOauthProvider(provider)) return null;
  const clientId = env[envName(provider, "CLIENT_ID")]?.trim();
  const clientSecret = env[envName(provider, "CLIENT_SECRET")]?.trim();
  if (!clientId || !clientSecret) return null;
  if (provider === "vercel") {
    const slug = env.VERCEL_INTEGRATION_SLUG?.trim();
    if (!slug) return null;
    return { provider, clientId, clientSecret, slug };
  }
  return { provider, clientId, clientSecret };
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Only the web app's provider callback may receive the authorization code. */
export function allowedOauthRedirect(redirectUri: string, webOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.pathname !== "/providers/callback") return false;
  if (url.username || url.password || url.hash) return false;
  if (webOrigin.trim() === "*") {
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  }
  return url.origin === webOrigin.trim().replace(/\/$/, "");
}

export function authorizeUrl(
  app: OauthApp,
  args: { redirectUri: string; state: string; challenge?: string },
): string {
  if (app.provider === "vercel") {
    const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(app.slug ?? "")}/new`);
    url.searchParams.set("state", args.state);
    return url.toString();
  }
  const url =
    app.provider === "neon"
      ? new URL("https://oauth2.neon.tech/oauth2/auth")
      : new URL("https://api.supabase.com/v1/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", args.state);
  if (app.provider === "neon") url.searchParams.set("scope", NEON_SCOPES);
  if (args.challenge) {
    url.searchParams.set("code_challenge", args.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Map a provider token onto the credential fields the adapters already read. */
export function credentialValues(provider: OauthProvider, token: OauthToken, now = Date.now()): Record<string, string> {
  const values: Record<string, string> =
    provider === "vercel"
      ? { apiToken: token.access_token }
      : provider === "neon"
        ? { apiKey: token.access_token }
        : { accessToken: token.access_token };
  if (provider === "vercel" && token.team_id) values.teamId = token.team_id;
  if (token.refresh_token) values.refreshToken = token.refresh_token;
  if (typeof token.expires_in === "number" && token.expires_in > 0) {
    values.expiresAt = String(now + token.expires_in * 1000);
  }
  return values;
}

async function readToken(res: Response): Promise<OauthToken> {
  if (!res.ok) throw new Error(`Provider token request failed (${res.status}).`);
  const json = (await res.json()) as OauthToken;
  if (!json.access_token) throw new Error("Provider token response did not include an access token.");
  return json;
}

export async function exchangeOauthCode(
  app: OauthApp,
  args: { code: string; redirectUri: string; verifier?: string; fetchImpl?: typeof fetch },
): Promise<Record<string, string>> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  if (args.verifier) body.set("code_verifier", args.verifier);
  if (app.provider === "vercel") body.delete("grant_type");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const url =
    app.provider === "vercel"
      ? "https://api.vercel.com/v2/oauth/access_token"
      : app.provider === "neon"
        ? "https://oauth2.neon.tech/oauth2/token"
        : "https://api.supabase.com/v1/oauth/token";
  if (app.provider === "supabase") {
    headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  }
  const res = await fetchImpl(url, { method: "POST", headers, body });
  return credentialValues(app.provider, await readToken(res));
}

/**
 * Refresh a short-lived Neon or Supabase token. Vercel integration tokens are
 * long-lived and are left alone. A missing app config or a provider error
 * returns the current values so a pasted key is never rewritten.
 */
export async function refreshOAuthCredentials(
  provider: string,
  values: Record<string, string>,
  opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: number },
): Promise<{ values: Record<string, string>; rotated: boolean }> {
  const refreshToken = values.refreshToken?.trim();
  if (!refreshToken || (provider !== "neon" && provider !== "supabase")) return { values, rotated: false };
  const now = opts?.now ?? Date.now();
  const expiresAt = Number(values.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now + 120_000) return { values, rotated: false };
  const app = loadOauthApp(provider, opts?.env ?? process.env);
  if (!app) return { values, rotated: false };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const url = provider === "neon" ? "https://oauth2.neon.tech/oauth2/token" : "https://api.supabase.com/v1/oauth/token";
  if (provider === "supabase") {
    headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  }
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body });
    const token = await readToken(res);
    if (!token.refresh_token) token.refresh_token = refreshToken;
    return { values: credentialValues(app.provider, token, now), rotated: true };
  } catch {
    return { values, rotated: false };
  }
}

interface StateBody {
  userId: string;
  provider: OauthProvider;
  exp: number;
}

/** Untrusted read of the provider name, used only to pick the HMAC secret before verify. */
export function peekOauthProvider(state: string): OauthProvider | null {
  const payload = state.split(".")[0];
  if (!payload) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { provider?: string };
    return body.provider && isOauthProvider(body.provider) ? body.provider : null;
  } catch {
    return null;
  }
}

export function signOauthState(secret: string, body: StateBody): string {
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Returns the signed body only when the HMAC matches and the state has not expired. */
export function verifyOauthState(
  secret: string,
  state: string,
  expected: { userId: string; provider: string },
  now = Date.now(),
): StateBody | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let body: StateBody;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StateBody;
  } catch {
    return null;
  }
  if (body.userId !== expected.userId || body.provider !== expected.provider) return null;
  if (!Number.isFinite(body.exp) || body.exp < now) return null;
  return body;
}
