import type { DeploymentPlan } from "@shipfix/contracts";
import { questionForSetting } from "@shipfix/contracts";

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,64}$/;

export function isSettingName(value: string | null | undefined): value is string {
  return !!value && ENV_NAME_RE.test(value);
}

function envNameOf(questionId: string): string {
  const i = questionId.lastIndexOf("-");
  return i === -1 ? "" : questionId.slice(i + 1);
}

/** True when an answer, or a project env of the same name, already covers the question. */
export function questionSatisfied(
  questionId: string,
  answeredQuestionIds: ReadonlySet<string>,
  satisfiedEnvNames: ReadonlySet<string>,
): boolean {
  if (answeredQuestionIds.has(questionId)) return true;
  const envName = envNameOf(questionId);
  return envName.length > 0 && satisfiedEnvNames.has(envName);
}

/**
 * Pause only for a setup plan that still has a real unanswered question.
 * A diagnosis (the app is out of scope) is not something an answer can fix.
 */
export function shouldWaitForInput(
  plan: Pick<DeploymentPlan, "classification" | "questions">,
  answeredQuestionIds: ReadonlySet<string>,
  satisfiedEnvNames: ReadonlySet<string> = new Set(),
): boolean {
  if (plan.classification !== "needs_setup") return false;
  return plan.questions.some((q) => !questionSatisfied(q.id, answeredQuestionIds, satisfiedEnvNames));
}

export interface MissingSetting {
  serviceId: string;
  envName: string;
}

/** Add a secret question and a user_secret env for each setting the deploy found missing. */
export function withMissingSettings(plan: DeploymentPlan, missing: MissingSetting[]): DeploymentPlan {
  const next = structuredClone(plan);
  for (const item of missing) {
    if (!isSettingName(item.envName)) continue;
    const question = questionForSetting(item.serviceId, item.envName);
    if (!next.questions.some((q) => q.id === question.id)) next.questions.push(question);
    const service = next.services.find((s) => s.id === item.serviceId);
    if (service && !service.env.some((e) => e.name === item.envName)) {
      service.env.push({ name: item.envName, source: "user_secret" });
    }
  }
  return next;
}
