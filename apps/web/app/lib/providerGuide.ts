/**
 * Beginner-facing knowledge about each provider ShipFix can use: what the key is
 * for, where to create it, what scope it needs, and provider lifecycle quirks.
 * Provider connections are account-level and reusable; each deployed app still
 * gets its own isolated provider resources.
 */

export type ProviderId = "neon" | "upstash" | "render" | "vercel" | "supabase";

export interface ProviderExtraStep {
  title: string;
  detail: string;
  url?: string;
  urlLabel?: string;
}

export interface ProviderGuide {
  id: ProviderId;
  name: string;
  /** One-line role in a deployment. */
  blurb: string;
  credentialField: "apiKey" | "apiToken" | "accessToken";
  credentialLabel: string;
  /** Extra credential inputs; `required` ones must be filled before connecting. */
  optionalFields?: Array<{ field: string; label: string; placeholder: string; required?: boolean }>;
  /** What ShipFix does with the key. */
  whatFor: string;
  /** Direct link to create the credential. */
  tokenUrl: string;
  tokenUrlLabel: string;
  /** Access/scope the key needs. */
  scope: string;
  /** Provider behavior a beginner should know about. */
  lifecycle?: string;
  /** Additional setup, for example Vercel GitHub access. Shown even after the token is saved. */
  extraStepsTitle?: string;
  extraSteps?: ProviderExtraStep[];
}

export const ENCRYPTION_NOTE =
  "ShipFix sends this key to the backend once, seals it with envelope encryption, and never sends it to the AI planner or the browser again.";

export const REUSE_NOTE =
  "These are account-level provider tokens, not per-app tokens. Connect each provider once, then ShipFix can create separate resources for each deployment.";

export const PROVIDER_GUIDES: Record<ProviderId, ProviderGuide> = {
  neon: {
    id: "neon",
    name: "Neon",
    blurb: "Postgres database",
    credentialField: "apiKey",
    credentialLabel: "API key",
    whatFor:
      "ShipFix uses Neon to create the Postgres database and injects the sealed DATABASE_URL into the backend before deploy.",
    tokenUrl: "https://console.neon.tech/app/settings/api-keys",
    tokenUrlLabel: "Neon API keys",
    scope: "Use a personal or account API key that can create projects and databases.",
    lifecycle:
      "The API also needs NEON_ORG_ID in its environment. A free Neon database may sleep when idle and wake on the first query.",
  },
  upstash: {
    id: "upstash",
    name: "Upstash",
    blurb: "Redis",
    credentialField: "apiKey",
    credentialLabel: "Management API key",
    optionalFields: [
      { field: "email", label: "Account email", placeholder: "Upstash account email", required: true },
      { field: "region", label: "Region", placeholder: "Optional: AWS region, default us-east-1" },
    ],
    whatFor:
      "ShipFix uses Upstash to create a Redis database for your app and injects the sealed REDIS_URL (or the Upstash REST URL and token) into the server before deploy.",
    tokenUrl: "https://console.upstash.com/account/api",
    tokenUrlLabel: "Upstash Management API",
    scope: "Use a Management API key from the Upstash account that should own the database, together with that account's email.",
    lifecycle:
      "Each app gets its own Upstash database, kept across redeploys. The free plan limits how many databases you can have.",
  },
  render: {
    id: "render",
    name: "Render",
    blurb: "Backend API hosting",
    credentialField: "apiKey",
    credentialLabel: "API key",
    whatFor:
      "ShipFix uses Render to create the backend web service, set build/start commands, add environment variables, and deploy the API.",
    tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
    tokenUrlLabel: "Render API keys",
    scope: "Use an account API key that can create and deploy services.",
    optionalFields: [
      { field: "ownerId", label: "Owner ID", placeholder: "Optional: Render ownerId for team accounts" },
    ],
    lifecycle:
      "Render free web services can sleep after inactivity. The first request after sleeping may take longer, which is normal.",
  },
  vercel: {
    id: "vercel",
    name: "Vercel",
    blurb: "Frontend hosting",
    credentialField: "apiToken",
    credentialLabel: "API token",
    whatFor:
      "ShipFix uses Vercel to create the frontend project, set build-time env like VITE_API_URL, and deploy the user-facing app.",
    tokenUrl: "https://vercel.com/account/tokens",
    tokenUrlLabel: "Vercel tokens",
    scope: "Use a token with access to the personal account or team that will own the project.",
    optionalFields: [
      { field: "teamId", label: "Team ID", placeholder: "team_xxx — required if projects live under a Vercel team" },
    ],
    extraStepsTitle: "Vercel to GitHub",
    extraSteps: [
      {
        title: "Connect GitHub on Vercel",
        detail:
          "Open Vercel login connections. Add GitHub on the same Vercel account as the token you pasted above.",
        url: "https://vercel.com/account/login-connections",
        urlLabel: "Open Vercel login connections",
      },
      {
        title: "Let Vercel read this repository",
        detail:
          "Sign in to GitHub. Open GitHub installations. Click Vercel, then Configure. Include this repository and press Save. The button on that page is Configure. If the top of the page says Sign in, press Sign in first.",
        url: "https://github.com/settings/installations",
        urlLabel: "Open GitHub installations",
      },
      {
        title: "Deploy again",
        detail: "Come back to ShipFix and press Deploy. This page stays on the failed run until you start deploy again.",
      },
    ],
  },
  supabase: {
    id: "supabase",
    name: "Supabase",
    blurb: "Your existing Supabase project",
    credentialField: "accessToken",
    credentialLabel: "Personal access token",
    whatFor:
      "Your app already uses a Supabase project. At deploy time ShipFix reads that project's URL, anon key, and service-role key and sets them as env vars, so you don't have to copy them by hand. ShipFix never changes your Supabase project.",
    tokenUrl: "https://supabase.com/dashboard/account/tokens",
    tokenUrlLabel: "Supabase access tokens",
    scope: "Use a personal access token from the Supabase account that owns the app's project.",
    lifecycle:
      "The service-role key only goes to server-side env vars, never into browser code. You can still override any value by setting it on the app yourself.",
  },
};

export function providerGuide(id: string): ProviderGuide | null {
  return (PROVIDER_GUIDES as Record<string, ProviderGuide>)[id] ?? null;
}

export const ALL_PROVIDER_IDS: ProviderId[] = ["neon", "upstash", "render", "vercel", "supabase"];
