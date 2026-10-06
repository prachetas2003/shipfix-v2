import type { DeploymentPlan, RepoContext } from "@shipfix/contracts";

/**
 * Fill committed browser-public values into an LLM plan. The model only sees
 * publicEnvNames; values stay in code. Any env the model marked `user_secret`
 * or valueless `literal` for such a name becomes a literal, and the matching
 * secret question is dropped so the user isn't asked for it.
 */
export function applyPublicEnv(plan: DeploymentPlan, ctx: RepoContext): DeploymentPlan {
  const publicEnv = ctx.publicEnv ?? [];
  if (publicEnv.length === 0) return plan;
  const filled = new Set<string>();
  const services = plan.services.map((s) => ({
    ...s,
    env: s.env.map((e) => {
      const needsValue = e.source === "user_secret" || (e.source === "literal" && !e.value);
      if (!needsValue) return e;
      const match =
        publicEnv.find((v) => v.service === s.rootDir && v.name === e.name) ??
        publicEnv.find((v) => v.name === e.name);
      if (!match) return e;
      filled.add(`secret-${s.id}-${e.name}`);
      return { name: e.name, source: "literal" as const, value: match.value };
    }),
  }));
  if (filled.size === 0) return plan;
  return { ...plan, services, questions: plan.questions.filter((q) => !filled.has(q.id)) };
}
