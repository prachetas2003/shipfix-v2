/**
 * Beginner-facing knowledge about each provider ShipFix can use: what the key is
 * for, exactly where to create it, what scope it needs, and provider lifecycle
 * quirks. Account-level and reusable — connect once, deploy many apps; each app
 * still gets its own isolated provider resources.
 */

export type ProviderId = "neon" | "render" | "vercel";

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
  credentialField: "apiKey" | "apiToken";
  credentialLabel: string;
  optionalFields?: Array<{ field: string; label: string; placeholder: string }>;
  /** What ShipFix does with the key. */
  whatFor: string;
  /** Direct link to create the credential. */
  tokenUrl: string;
  tokenUrlLabel: string;
  /** Access/scope the key needs. */
  scope: string;
  /** Provider behavior a beginner should know about. */
  lifecycle?: string;
  /** Additional setup (e.g. Vercel needs GitHub connected). */
  extraSteps?: ProviderExtraStep[];
}

export const ENCRYPTION_NOTE =
  "Your key is sent once over HTTPS and sealed with envelope encryption (AES-256-GCM) on the server. It is never logged, never shown again, and never sent to the AI planner.";

export const REUSE_NOTE =
  "Provider connections are account-level and reusable. Connect a provider once and deploy as many apps as you like — each app gets its own separate resources, so deploying a new app never touches an existing one.";

export const PROVIDER_GUIDES: Record<ProviderId, ProviderGuide> = {
  neon: {
    id: "neon",
    name: "Neon",
    blurb: "Serverless Postgres database",
    credentialField: "apiKey",
    credentialLabel: "API key",
    whatFor:
      "ShipFix provisions a Postgres database for your app and wires its connection string (DATABASE_URL) into your backend automatically.",
    tokenUrl: "https://console.neon.tech/app/settings/api-keys",
    tokenUrlLabel: "Neon API keys",
    scope: "A personal/account API key with permission to create projects and databases.",
    lifecycle:
      "Neon free databases may scale to zero when idle and wake on the next connection (first query can be slightly slower).",
  },
  render: {
    id: "render",
    name: "Render",
    blurb: "Backend hosting (node_api)",
    credentialField: "apiKey",
    credentialLabel: "API key",
    whatFor:
      "ShipFix creates a Render web service for your backend, sets its build/start commands and env vars, and deploys it.",
    tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
    tokenUrlLabel: "Render API keys",
    scope: "An account API key that can create and deploy services.",
    optionalFields: [
      { field: "ownerId", label: "Owner ID", placeholder: "Optional: Render ownerId for team accounts" },
    ],
    lifecycle:
      "Render free web services sleep after ~15 minutes of inactivity and wake on the next request — the first request after idling can take ~30 seconds. This is normal, not a crash.",
  },
  vercel: {
    id: "vercel",
    name: "Vercel",
    blurb: "Frontend hosting (static / SPA)",
    credentialField: "apiToken",
    credentialLabel: "API token",
    whatFor:
      "ShipFix creates a Vercel project for your frontend, sets build env vars (e.g. VITE_API_URL pointing at your backend), and deploys it from your GitHub repo.",
    tokenUrl: "https://vercel.com/account/tokens",
    tokenUrlLabel: "Vercel tokens",
    scope: "A token with access to the team/account that will own the project.",
    optionalFields: [
      { field: "teamId", label: "Team ID", placeholder: "Optional: team_xxx for Vercel teams" },
    ],
    extraSteps: [
      {
        title: "Connect GitHub to Vercel (required)",
        detail:
          "Vercel deploys your frontend straight from GitHub, so your GitHub account must be connected to Vercel and the Vercel GitHub app must have access to this repo. Without this, the frontend deploy fails with a GitHub connection error.",
        url: "https://vercel.com/account/login-connections",
        urlLabel: "Vercel login connections",
      },
      {
        title: "Install the Vercel GitHub app on the repo",
        detail:
          "If the repo still is not found, install/authorize the Vercel GitHub app for the repository owner.",
        url: "https://github.com/apps/vercel",
        urlLabel: "Vercel GitHub app",
      },
    ],
  },
};

export function providerGuide(id: string): ProviderGuide | null {
  return (PROVIDER_GUIDES as Record<string, ProviderGuide>)[id] ?? null;
}

export const ALL_PROVIDER_IDS: ProviderId[] = ["neon", "render", "vercel"];
