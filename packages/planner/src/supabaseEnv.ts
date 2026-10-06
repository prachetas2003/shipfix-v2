import type { DeploymentPlan, IntegrationField, PlanQuestion, RepoContext } from "@shipfix/contracts";

const CLIENT_PREFIX_RE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

export const SUPABASE_INTEGRATION_ID = "supabase";
export const SUPABASE_PROJECT_QUESTION_ID = "integration-supabase-project";

/**
 * Which Supabase project value an env name expects. The service-role key is
 * only ever mapped to server-side names; a bare server `SUPABASE_KEY` is left
 * to the user because apps use it for both the anon and service-role key.
 */
export function supabaseFieldFor(name: string, runsInBrowser: boolean): IntegrationField | null {
  const clientSide = runsInBrowser || CLIENT_PREFIX_RE.test(name);
  const bare = name.replace(CLIENT_PREFIX_RE, "");
  switch (bare) {
    case "SUPABASE_URL":
      return "url";
    case "SUPABASE_ANON_KEY":
    case "SUPABASE_PUBLISHABLE_KEY":
    case "SUPABASE_PUBLISHABLE_DEFAULT_KEY":
      return "anonKey";
    case "SUPABASE_KEY":
      return CLIENT_PREFIX_RE.test(name) ? "anonKey" : null;
    case "SUPABASE_PROJECT_ID":
    case "SUPABASE_PROJECT_REF":
      return "projectRef";
    case "SUPABASE_SERVICE_ROLE_KEY":
    case "SUPABASE_SERVICE_KEY":
    case "SUPABASE_SECRET_KEY":
      return clientSide ? null : "serviceRoleKey";
    default:
      return null;
  }
}

export function supabaseProjectQuestion(blocksServiceIds: string[]): PlanQuestion {
  return {
    id: SUPABASE_PROJECT_QUESTION_ID,
    prompt:
      "Which Supabase project does this app use? Enter its project ref (the part before .supabase.co in the project URL).",
    kind: "choice",
    blocksServiceIds,
  };
}

/**
 * LLM plans: env the model left for the user that a connected Supabase
 * project can supply becomes an `integration` ref, and its question is dropped.
 */
export function applySupabaseIntegration(plan: DeploymentPlan, ctx: RepoContext): DeploymentPlan {
  if (!ctx.supabase) return plan;
  const replaced = new Set<string>();
  const services = plan.services.map((s) => {
    const inBrowser = s.type === "frontend_static";
    return {
      ...s,
      env: s.env.map((e) => {
        if (e.source !== "user_secret") return e;
        const field = supabaseFieldFor(e.name, inBrowser);
        if (!field) return e;
        replaced.add(`secret-${s.id}-${e.name}`);
        return { name: e.name, source: "integration" as const, ref: `${SUPABASE_INTEGRATION_ID}.${field}` };
      }),
    };
  });
  if (replaced.size === 0) return plan;
  const users = services.filter((s) => s.env.some((e) => e.source === "integration")).map((s) => s.id);
  const questions = plan.questions.filter((q) => !replaced.has(q.id));
  const projectRef = ctx.supabase.projectRef;
  if (!projectRef && !questions.some((q) => q.id === SUPABASE_PROJECT_QUESTION_ID)) {
    questions.push(supabaseProjectQuestion(users));
  }
  const integrations = (plan.integrations ?? []).some((i) => i.id === SUPABASE_INTEGRATION_ID)
    ? plan.integrations
    : [...(plan.integrations ?? []), { id: SUPABASE_INTEGRATION_ID, provider: "supabase" as const, projectRef }];
  return { ...plan, services, questions, integrations };
}
