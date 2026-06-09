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

export function failureEventForMessage(message: string): {
  event: "usage_limit_reached" | "llm_config_missing" | "planning_failed" | "run_failed";
  title: string;
} {
  if (/alpha usage limit|usage limit|try again later/i.test(message)) {
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
