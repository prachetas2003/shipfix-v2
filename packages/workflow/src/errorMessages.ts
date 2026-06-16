// WORKFLOW-SAFE MODULE: this file is bundled into the Temporal workflow
// sandbox (imported by workflows.ts). It must stay pure — no Node builtins and
// no imports that transitively reach node:crypto, secrets, DB clients, LLM
// runtime code, or provider adapters. `@shipfix/llm/errors` is the pure
// error-types subpath (zero imports); NEVER switch this to `@shipfix/llm`,
// whose index pulls in @shipfix/secrets -> node:crypto and breaks the worker
// at startup. Guarded by packages/workflow/test/workflowBundle.test.ts.
import { LLMProviderError, llmKindFromMessage } from "@shipfix/llm/errors";

const GENERIC_TEMPORAL_MESSAGES = new Set([
  "Activity task failed",
  "Workflow execution failed",
]);

function messageOf(value: unknown): string | null {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }
  return typeof value === "string" ? value : null;
}

function causeOf(value: unknown): unknown {
  if (value instanceof Error) return value.cause;
  if (typeof value === "object" && value !== null && "cause" in value) {
    return (value as { cause?: unknown }).cause;
  }
  return undefined;
}

export function unwrapFailureMessage(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  let fallback: string | null = null;

  while (current && !seen.has(current)) {
    seen.add(current);
    const message = messageOf(current);
    if (message && !GENERIC_TEMPORAL_MESSAGES.has(message)) return message;
    fallback ??= message;
    current = causeOf(current);
  }

  return fallback ?? "Run failed unexpectedly.";
}

export type RunFailureEvent =
  | "usage_limit_reached"
  | "llm_unavailable"
  | "llm_config_missing"
  | "planning_failed"
  | "internal_plan_transition_failed"
  | "internal_plan_generation_failed"
  | "internal_plan_generation_stalled"
  | "internal_control_plane_consistency_error"
  | "run_failed";

export interface ClassifiedFailure {
  event: RunFailureEvent;
  title: string;
}

const LLM_UNAVAILABLE: ClassifiedFailure = {
  event: "llm_unavailable",
  title: "AI planner temporarily unavailable",
};

/**
 * Classify a failure that has been flattened to a message string (e.g. after
 * crossing the Temporal boundary). Order matters:
 *  1. Typed LLM provider phrases (stable markers from LLMProviderError) — a
 *     provider 429/503 is "model temporarily unavailable", NEVER a ShipFix
 *     usage limit, even if the provider body says "try again later".
 *  2. ShipFix metering messages (exact "Usage limit reached:" prefix or alpha
 *     wording) — the only source of usage_limit_reached.
 *  3. Missing/invalid LLM configuration.
 *  4. Other planning-flavored failures.
 */
export function failureEventForMessage(message: string): ClassifiedFailure {
  if (/internal_plan_transition_failed/i.test(message)) {
    return { event: "internal_plan_transition_failed", title: "Plan transition failed inside ShipFix" };
  }
  if (/internal_plan_generation_stalled/i.test(message)) {
    return { event: "internal_plan_generation_stalled", title: "Plan generation stalled inside ShipFix" };
  }
  if (/internal_plan_generation_failed/i.test(message)) {
    return { event: "internal_plan_generation_failed", title: "Plan generation failed inside ShipFix" };
  }
  if (/Run [0-9a-f-]{36} not found/i.test(message) || /internal_control_plane_consistency_error/i.test(message)) {
    return {
      event: "internal_control_plane_consistency_error",
      title: "Control plane database mismatch",
    };
  }
  const llmKind = llmKindFromMessage(message);
  if (llmKind === "rate_limited" || llmKind === "unavailable" || llmKind === "timeout") {
    return LLM_UNAVAILABLE;
  }
  if (llmKind === "auth") {
    return { event: "llm_config_missing", title: "Planner setup is invalid" };
  }
  if (/usage limit reached:|alpha usage limit/i.test(message)) {
    return { event: "usage_limit_reached", title: "Usage limit reached" };
  }
  if (/LLM gateway not configured|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|LLM_API_KEY|LLM_PROVIDER|LLM_MODEL/i.test(message)) {
    return { event: "llm_config_missing", title: "Planner setup is missing" };
  }
  if (/plan|planner|model|LLM/i.test(message)) {
    return { event: "planning_failed", title: "Planning failed" };
  }
  return { event: "run_failed", title: "Run failed" };
}

/** Classify from the typed error when available; fall back to the message. */
export function failureEventForError(err: unknown): ClassifiedFailure {
  if (err instanceof Error && err.name === "ControlPlaneConsistencyError") {
    return {
      event: "internal_control_plane_consistency_error",
      title: "Control plane database mismatch",
    };
  }
  if (err instanceof LLMProviderError) {
    if (err.kind === "auth") return { event: "llm_config_missing", title: "Planner setup is invalid" };
    if (err.kind === "bad_request") return { event: "planning_failed", title: "Planning failed" };
    return LLM_UNAVAILABLE;
  }
  return failureEventForMessage(unwrapFailureMessage(err));
}
