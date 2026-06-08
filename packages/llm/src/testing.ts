/**
 * TEST-ONLY gateway doubles. Exposed via the `@shipfix/llm/testing` subpath so
 * they can never be mistaken for the product brain (which is the real,
 * env-configured `createLLMGateway`). Do not use in app/worker code.
 */
import type { LLMGateway, LLMRequest } from "./types";

export interface FakeGateway {
  gateway: LLMGateway;
  /** Every request the gateway received, in order (for assertions). */
  calls: LLMRequest[];
}

type Script = string | string[] | ((req: LLMRequest, index: number) => string);

/**
 * A scripted gateway: returns a fixed string, the next item of an array
 * (clamped to the last), or the result of a responder fn. Records all calls.
 */
export function createFakeGateway(script: Script, model = "fake"): FakeGateway {
  const calls: LLMRequest[] = [];
  let i = 0;
  const next = (req: LLMRequest): string => {
    if (typeof script === "function") return script(req, i++);
    if (Array.isArray(script)) {
      const out = script[Math.min(i, script.length - 1)] ?? "";
      i++;
      return out;
    }
    return script;
  };
  return {
    calls,
    gateway: {
      model,
      async complete(req) {
        calls.push(req);
        return { text: next(req), model };
      },
    },
  };
}
