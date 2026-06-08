/** A single structured completion request. Plain text in, plain text out. */
export interface LLMRequest {
  /** System instruction (role + rules + schema). */
  system: string;
  /** User content (the task + evidence). */
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMResult {
  text: string;
  model: string;
  usage?: LLMUsage;
}

/**
 * The narrow gateway every planner/recovery caller depends on. Implementations
 * are provider-specific (Anthropic, Gemini) or test doubles. Callers never know
 * which model answered, only that they get text back.
 */
export interface LLMGateway {
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResult>;
}
