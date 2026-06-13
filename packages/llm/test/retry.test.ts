import { describe, expect, it } from "vitest";
import {
  LLMProviderError,
  isRetryableLLMError,
  llmKindFromMessage,
  llmKindFromStatus,
  retryingGateway,
} from "../src/index";
import type { LLMGateway, LLMResult } from "../src/types";

const noSleep = (): Promise<void> => Promise.resolve();

function flakyGateway(failures: Error[], result = "ok"): { gateway: LLMGateway; calls: () => number } {
  let calls = 0;
  return {
    gateway: {
      model: "fake",
      async complete(): Promise<LLMResult> {
        const failure = failures[calls];
        calls++;
        if (failure) throw failure;
        return { text: result, model: "fake" };
      },
    },
    calls: () => calls,
  };
}

describe("llmKindFromStatus", () => {
  it("maps statuses to kinds", () => {
    expect(llmKindFromStatus(429)).toBe("rate_limited");
    expect(llmKindFromStatus(503)).toBe("unavailable");
    expect(llmKindFromStatus(500)).toBe("unavailable");
    expect(llmKindFromStatus(401)).toBe("auth");
    expect(llmKindFromStatus(403)).toBe("auth");
    expect(llmKindFromStatus(400)).toBe("bad_request");
    expect(llmKindFromStatus(408)).toBe("timeout");
  });
});

describe("llmKindFromMessage", () => {
  it("recovers the kind from a flattened error message", () => {
    const err = new LLMProviderError({ kind: "unavailable", status: 503, detail: "try again later" });
    expect(llmKindFromMessage(err.message)).toBe("unavailable");
  });

  it("ignores unrelated messages even with provider-like phrases", () => {
    expect(llmKindFromMessage("Usage limit reached: llm_run_limit (3 LLM calls per run). Try again later.")).toBeNull();
  });
});

describe("retryingGateway", () => {
  it("retries transient failures and succeeds", async () => {
    const flaky = flakyGateway([
      new LLMProviderError({ kind: "rate_limited", status: 429 }),
      new LLMProviderError({ kind: "unavailable", status: 503 }),
    ]);
    const gw = retryingGateway(flaky.gateway, { maxAttempts: 3, sleep: noSleep });

    const res = await gw.complete({ system: "s", user: "u" });
    expect(res.text).toBe("ok");
    expect(flaky.calls()).toBe(3);
  });

  it("gives up after maxAttempts and rethrows the last transient error", async () => {
    const errs = Array.from({ length: 5 }, () => new LLMProviderError({ kind: "unavailable", status: 503 }));
    const flaky = flakyGateway(errs);
    const gw = retryingGateway(flaky.gateway, { maxAttempts: 3, sleep: noSleep });

    await expect(gw.complete({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "unavailable" });
    expect(flaky.calls()).toBe(3);
  });

  it("does not retry auth failures", async () => {
    const flaky = flakyGateway([new LLMProviderError({ kind: "auth", status: 401 })]);
    const gw = retryingGateway(flaky.gateway, { maxAttempts: 3, sleep: noSleep });

    await expect(gw.complete({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "auth" });
    expect(flaky.calls()).toBe(1);
  });

  it("does not retry plain errors", async () => {
    const flaky = flakyGateway([new Error("schema mismatch")]);
    const gw = retryingGateway(flaky.gateway, { maxAttempts: 3, sleep: noSleep });

    await expect(gw.complete({ system: "s", user: "u" })).rejects.toThrow("schema mismatch");
    expect(flaky.calls()).toBe(1);
  });
});

describe("isRetryableLLMError", () => {
  it("classifies retryable vs terminal", () => {
    expect(isRetryableLLMError(new LLMProviderError({ kind: "rate_limited" }))).toBe(true);
    expect(isRetryableLLMError(new LLMProviderError({ kind: "timeout" }))).toBe(true);
    expect(isRetryableLLMError(new LLMProviderError({ kind: "auth" }))).toBe(false);
    expect(isRetryableLLMError(new Error("x"))).toBe(false);
  });
});
