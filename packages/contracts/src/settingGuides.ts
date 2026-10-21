import type { PlanQuestion } from "./deploymentPlan";

export interface SettingGuide {
  help: string;
  helpUrl?: string;
}

const EXACT: Record<string, SettingGuide> = {
  STRIPE_SECRET_KEY: {
    help: "Stripe Dashboard → Developers → API keys → Secret key. Use the test key (sk_test_…) while trying ShipFix.",
    helpUrl: "https://dashboard.stripe.com/apikeys",
  },
  STRIPE_WEBHOOK_SECRET: {
    help: "Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret.",
    helpUrl: "https://dashboard.stripe.com/webhooks",
  },
  OPENAI_API_KEY: {
    help: "OpenAI platform → API keys → Create new secret key.",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  ANTHROPIC_API_KEY: {
    help: "Claude Console → API keys.",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  CLERK_SECRET_KEY: {
    help: "Clerk Dashboard → API keys → Secret keys.",
    helpUrl: "https://dashboard.clerk.com",
  },
  RESEND_API_KEY: {
    help: "Resend → API Keys → Create API key.",
    helpUrl: "https://resend.com/api-keys",
  },
  GITHUB_CLIENT_SECRET: {
    help: "GitHub → Settings → Developer settings → OAuth Apps → your app → Client secrets.",
    helpUrl: "https://github.com/settings/developers",
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    help: "Supabase → Project Settings → API keys → service_role. This key bypasses row security; it stays on the server.",
    helpUrl: "https://supabase.com/dashboard/project/_/settings/api",
  },
};

const PREFIXES: Array<{ prefix: string; guide: SettingGuide }> = [
  { prefix: "STRIPE_", guide: EXACT.STRIPE_SECRET_KEY! },
  { prefix: "OPENAI_", guide: EXACT.OPENAI_API_KEY! },
  { prefix: "ANTHROPIC_", guide: EXACT.ANTHROPIC_API_KEY! },
  { prefix: "CLERK_", guide: EXACT.CLERK_SECRET_KEY! },
  { prefix: "RESEND_", guide: EXACT.RESEND_API_KEY! },
  { prefix: "SUPABASE_", guide: EXACT.SUPABASE_SERVICE_ROLE_KEY! },
  {
    prefix: "AWS_",
    guide: {
      help: "AWS console → IAM → Users → Security credentials → Access keys.",
      helpUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    },
  },
];

/** Where a builder should copy this setting from. Always returns guidance. */
export function settingGuide(envName: string): SettingGuide {
  const exact = EXACT[envName];
  if (exact) return exact;
  const prefixed = PREFIXES.find((p) => envName.startsWith(p.prefix));
  if (prefixed) return prefixed.guide;
  return {
    help: `Copy the value of ${envName} from the service that issued it. ShipFix encrypts it and never shows it again.`,
  };
}

/** A secret question for an env var the deploy discovered was missing. */
export function questionForSetting(serviceId: string, envName: string): PlanQuestion {
  const guide = settingGuide(envName);
  return {
    id: `secret-${serviceId}-${envName}`,
    prompt: `The app needs ${envName} before it can run. Paste the value.`,
    kind: "secret",
    blocksServiceIds: [serviceId],
    help: guide.help,
    ...(guide.helpUrl ? { helpUrl: guide.helpUrl } : {}),
  };
}
