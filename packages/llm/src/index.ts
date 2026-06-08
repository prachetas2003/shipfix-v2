/**
 * @shipfix/llm — the LLM gateway with a structured-output helper and a hard
 * redaction wall.
 *
 * Two invariants:
 *  1. Every prompt that leaves the process is redacted first (defense in depth;
 *     RepoContext is already names-only, but secrets must NEVER reach a model).
 *  2. Model output only becomes typed data via `parseStructured` against a Zod
 *     schema — the gateway never trusts free-form text as a contract.
 */
import { redact } from "@shipfix/secrets";
import type { LLMGateway } from "./types";
import { createAnthropicGateway, createGeminiGateway, createOpenAIGateway } from "./providers";

export type { LLMGateway, LLMRequest, LLMResult, LLMUsage } from "./types";
export { extractJsonBlock, parseStructured, type ParseResult } from "./json";
export { createAnthropicGateway, createGeminiGateway, createOpenAIGateway } from "./providers";

/**
 * Wrap any gateway so every outbound prompt is redacted. This is the wall that
 * structurally guarantees no secret value can be sent to a provider.
 */
export function redactingGateway(inner: LLMGateway): LLMGateway {
  return {
    model: inner.model,
    complete: (req) =>
      inner.complete({ ...req, system: redact(req.system), user: redact(req.user) }),
  };
}

/**
 * Build the real, env-configured gateway. Throws (does NOT silently fall back to
 * a mock) when unconfigured — the planner brain must be a real model.
 */
export function createLLMGateway(): LLMGateway {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;

  if (!provider || !model) {
    throw new Error(
      "LLM gateway not configured. Set LLM_PROVIDER (openai|anthropic|gemini), provider API key env, and LLM_MODEL.",
    );
  }

  let inner: LLMGateway;
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI LLM gateway not configured. Set OPENAI_API_KEY.");
    inner = createOpenAIGateway({ apiKey, model });
  } else if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Anthropic LLM gateway not configured. Set ANTHROPIC_API_KEY.");
    inner = createAnthropicGateway({ apiKey, model });
  } else if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Gemini LLM gateway not configured. Set GEMINI_API_KEY.");
    inner = createGeminiGateway({ apiKey, model });
  } else throw new Error(`Unknown LLM_PROVIDER "${provider}" (expected "openai", "anthropic" or "gemini").`);

  return redactingGateway(inner);
}
