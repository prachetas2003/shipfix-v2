/**
 * Typed LLM provider failures. Activities and the workflow classify failures
 * from `kind` (or from the stable message markers when the error has crossed a
 * process/Temporal boundary and only the string survived).
 */

export type LLMErrorKind = "rate_limited" | "unavailable" | "auth" | "bad_request" | "timeout";

const KIND_PHRASES: Record<LLMErrorKind, string> = {
  rate_limited: "rate limited",
  unavailable: "temporarily unavailable",
  auth: "authentication failed",
  bad_request: "request rejected",
  timeout: "request timed out",
};

/** Kinds worth retrying automatically — transient, not config or prompt bugs. */
export const RETRYABLE_LLM_KINDS: ReadonlySet<LLMErrorKind> = new Set([
  "rate_limited",
  "unavailable",
  "timeout",
]);

export class LLMProviderError extends Error {
  readonly kind: LLMErrorKind;
  readonly status: number | null;

  constructor(args: { kind: LLMErrorKind; status?: number | null; detail?: string }) {
    const statusPart = args.status ? ` (HTTP ${args.status})` : "";
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`LLM provider ${KIND_PHRASES[args.kind]}${statusPart}${detailPart}`);
    this.name = "LLMProviderError";
    this.kind = args.kind;
    this.status = args.status ?? null;
  }
}

/** Map an HTTP status from a model API to a failure kind. */
export function llmKindFromStatus(status: number): LLMErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

export function isRetryableLLMError(err: unknown): boolean {
  return err instanceof LLMProviderError && RETRYABLE_LLM_KINDS.has(err.kind);
}

/**
 * Best-effort kind recovery from a message string (after the typed error has
 * been flattened by Temporal or logging). Matches the stable phrases above.
 */
export function llmKindFromMessage(message: string): LLMErrorKind | null {
  if (!/llm provider/i.test(message)) return null;
  for (const [kind, phrase] of Object.entries(KIND_PHRASES) as [LLMErrorKind, string][]) {
    if (message.toLowerCase().includes(phrase)) return kind;
  }
  return null;
}
