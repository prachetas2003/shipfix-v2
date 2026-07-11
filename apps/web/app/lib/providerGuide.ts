/**
 * Beginner-facing knowledge about each provider ShipFix can use: what the key is
 * for, where to create it, what scope it needs, and provider lifecycle quirks.
 * Provider connections are account-level and reusable; each deployed app still
 * gets its own isolated provider resources.
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
  /** Additional setup, for example Vercel GitHub access. */
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
      "For local alpha testing, the ShipFix API/worker also needs NEON_ORG_ID in backend env. Free Neon databases may sleep when idle and wake on first query.",
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
    extraSteps: [
      {
        title: "Connect GitHub to Vercel",
        detail:
          "Vercel deploys from GitHub, so your Vercel account must be connected to GitHub and allowed to access this repo.",
        url: "https://vercel.com/account/login-connections",
        urlLabel: "Vercel login connections",
      },
      {
        title: "Authorize the Vercel GitHub app",
        detail:
          "If Vercel cannot find the repo, install or authorize the Vercel GitHub app for the repository owner.",
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
