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
import { isRetryableLLMError } from "./errors";

export type { LLMGateway, LLMRequest, LLMResult, LLMUsage } from "./types";
export { extractJsonBlock, parseStructured, type ParseResult } from "./json";
export { createAnthropicGateway, createGeminiGateway, createOpenAIGateway } from "./providers";
export {
  LLMProviderError,
  isRetryableLLMError,
  llmKindFromMessage,
  llmKindFromStatus,
  type LLMErrorKind,
} from "./errors";

export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms; grows exponentially with jitter (default 500). */
  baseDelayMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a gateway with bounded retry on transient provider failures
 * (rate limits, 5xx, timeouts). Auth/config/prompt errors fail immediately.
 */
export function retryingGateway(inner: LLMGateway, opts: RetryOptions = {}): LLMGateway {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  return {
    model: inner.model,
    async complete(req) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          const backoff = baseDelayMs * 2 ** (attempt - 1);
          await sleep(backoff + Math.floor(Math.random() * backoff * 0.5));
        }
        try {
          return await inner.complete(req);
        } catch (err) {
          lastErr = err;
          if (!isRetryableLLMError(err)) throw err;
        }
      }
      throw lastErr;
    },
  };
}

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

type Provider = "openai" | "anthropic" | "gemini";

const PROVIDER_KEY_ENV: Record<Provider, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY"> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function normalizeProvider(value: string | undefined): Provider | null {
  const provider = value?.trim().toLowerCase();
  return provider === "openai" || provider === "anthropic" || provider === "gemini" ? provider : null;
}

function resolveProviderApiKey(provider: Provider): { apiKey: string | undefined; expectedEnv: string; usedLegacy: boolean } {
  const expectedEnv = PROVIDER_KEY_ENV[provider];
  const providerKey = process.env[expectedEnv]?.trim();
  if (providerKey) return { apiKey: providerKey, expectedEnv, usedLegacy: false };

  // Backward-compatible local/dev fallback for older ShipFix env files. New
  // installs should prefer provider-specific names so config checks are clear.
  const legacyKey = process.env.LLM_API_KEY?.trim();
  if (legacyKey) return { apiKey: legacyKey, expectedEnv, usedLegacy: true };

  return { apiKey: undefined, expectedEnv, usedLegacy: false };
}

/**
 * Build the real, env-configured gateway. Throws (does NOT silently fall back to
 * a mock) when unconfigured — the planner brain must be a real model.
 */
export function createLLMGateway(): LLMGateway {
  const providerRaw = process.env.LLM_PROVIDER;
  const provider = normalizeProvider(providerRaw);
  const model = process.env.LLM_MODEL?.trim();

  if (!providerRaw?.trim() || !model) {
    throw new Error(
      "LLM gateway not configured. Set LLM_PROVIDER (openai|anthropic|gemini), provider API key env, and LLM_MODEL.",
    );
  }
  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER "${providerRaw}" (expected "openai", "anthropic" or "gemini").`);
  }

  const { apiKey, expectedEnv } = resolveProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`LLM gateway not configured for ${provider}. Set ${expectedEnv} (preferred) or LLM_API_KEY.`);
  }

  let inner: LLMGateway;
  if (provider === "openai") {
    inner = createOpenAIGateway({ apiKey, model });
  } else if (provider === "anthropic") {
    inner = createAnthropicGateway({ apiKey, model });
  } else {
    inner = createGeminiGateway({ apiKey, model });
  }

  // Transient model failures (429/5xx/timeouts) retry with backoff before
  // surfacing; one flaky provider response must not fail a whole run.
  return redactingGateway(retryingGateway(inner));
}
